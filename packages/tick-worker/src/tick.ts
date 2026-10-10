/**
 * One stateless tick of the Quoral house quoter and keeper. Runs every minute from a Cloudflare cron trigger
 * (src/index.ts) or in a loop on a laptop (scripts/local.ts).
 *
 * Each tick signs at most one transaction, to stay inside the Workers CPU budget:
 *   1. venue paused and the epoch is unquoted  -> heartbeat.flagPause()
 *   2. the current epoch has no proof          -> vault.requote(one level per side)
 *   3. enough ended epochs are unsettled       -> heartbeat.checkEpoch(last ended)
 *   4. the agreement has ended                 -> vault.cancel(), settle what is left, vault.finalize()
 *   5. nothing to do and TAKER_KEY is set      -> sometimes a market order from an independent taker
 *
 * The operator signs through a policy-locked Privy server wallet when PRIVY_WALLET_ID is set and that wallet is the
 * vault's operator (Privy signs, the tick broadcasts). Otherwise it falls back to OPERATOR_KEY, so the worker keeps
 * quoting across an operator rotation.
 * The vault cancels its own previous quotes inside requote, so the tick needs no order bookkeeping and no logs
 * (Monad's public RPC limits eth_getLogs to 100 blocks).
 *
 * The quoter tracks a real market: the mid of Kuru's XAUt0-USDC book on Monad mainnet (REF_MARKET on
 * REF_RPC_URL), clamped to the agreement's per-epoch drift cap. Quotes follow Avellaneda-Stoikov with an
 * inventory skew; when one side's inventory is used up the vault accepts everything left of it, or no quote
 * on that side at all (InventoryLimited).
 *
 * The public Monad testnet RPC allows 15 requests per second and counts every call inside a JSON-RPC batch, so
 * all reads go through Multicall3: a quoting tick makes about six requests in total.
 */
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { privySignTransaction, type PrivyCreds } from "@quoral/shared/privy";

export type Env = {
  RPC_URL: string;
  CHAIN_ID: string;
  VAULT: string;
  OPERATOR_KEY?: string; // local operator key (fallback, or the only signer without Privy)
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string; // secret
  PRIVY_WALLET_ID?: string;
  PRIVY_ADDRESS?: string; // the Privy wallet's address, so no lookup is needed per tick
  PAUSED?: string; // "1": read and report only, never send
  SETTLE_EVERY?: string; // settle once this many ended epochs are waiting (default 6)
  REF_RPC_URL?: string; // chain of the reference market (default Monad mainnet)
  REF_MARKET?: string; // Kuru v1 market whose mid the quoter tracks (default Kuru XAUt0-USDC on mainnet)
  SIGMA_BPS?: string; // volatility per sqrt(second) for the spread, and for the fallback walk (default 2)
  BLOCK_MS?: string; // for the fallback walk (default 302)
  INITIAL_MID?: string; // fallback reference before the first proof (default 4100)
  TAKER_KEY?: string; // optional independent taker that sends market orders on idle ticks (testnet flow)
  FLOW_PROB?: string; // chance per idle tick that the taker trades (default 0.2)
  GAS_HEADROOM_BPS?: string; // gas limit = estimate * (1 + headroom); Monad bills the limit (default 500 = 5%)
  PRIORITY_GWEI?: string; // tip on top of the base fee (default 0; testnet blocks are not full)
};

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const KURU_XAUT0_USDC = "0x851145eaeFdc37956B08dA829fa31722199F3f07";

const vaultAbi = parseAbi([
  "function isLive() view returns (bool)",
  "function finalized() view returns (bool)",
  "function startBlock() view returns (uint64)",
  "function endBlock() view returns (uint64)",
  "function currentEpoch() view returns (uint256)",
  "function totalEpochs() view returns (uint256)",
  "function heartbeat() view returns (address)",
  "function operator() view returns (address)",
  "function venuePaused() view returns (bool)",
  "function marginBalances() view returns (uint256 base, uint256 quote)",
  "function openOrders() view returns (uint40[])",
  "function minOrderSize() view returns (uint96)",
  "function priceRef() view returns ((uint64 lastMid2, uint48 lastEpoch, uint64 anchorMid2, uint48 anchorEpoch1, uint32 anchorGap))",
  "function terms() view returns ((address market, uint256 baseInventory, uint256 quoteInventory, uint16 maxSpreadBps, uint256 minDepthQuote, uint32 epochBlocks, uint32 uptimeWindowEpochs, uint16 uptimeBps, uint256 retainerPerBlock, uint64 durationBlocks, uint64 noticeBlocks, uint256 bondAmount, uint256 slashAmount, bool pauseExcused, uint16 maxMidMoveBps, uint32 startDelayBlocks))",
  "function marketScale() view returns ((uint256 pricePrecision, uint256 sizePrecision, uint256 baseDecimals, uint256 quoteDecimals, address baseToken, address quoteToken))",
  "function requote(uint32[] bidPrices, uint96[] bidSizes, uint32[] askPrices, uint96[] askSizes) returns (uint256)",
  "function cancel()",
  "function finalize()",
]);
const heartbeatAbi = parseAbi([
  "function status(uint256 epoch) view returns (uint8)",
  "function settledEpochs() view returns (uint256)",
  "function checkEpoch(uint256 epoch)",
  "function flagPause() returns (uint256)",
]);
const marketAbi = parseAbi([
  "function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
  "function bestBidAsk() view returns (uint256, uint256)",
  // the testnet book (Kuru v1 interface plus a public order view)
  "function orders(uint40 id) view returns (address owner, uint32 price, uint96 size, bool isBuy, bool active)",
  "function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function mint(address, uint256)",
]);
const blockAbi = parseAbi(["function getBlockNumber() view returns (uint256)"]);

const QUOTED = 1;
const MAX_SETTLE = 500n; // epochs settled per transaction

export type TickResult = {
  epoch?: string;
  action: "idle" | "quoted" | "settled" | "flagged" | "cancelled" | "finalized" | "skipped" | "paused" | "traded" | "error";
  detail: string;
  tx?: Hex;
};

function clients(env: Env) {
  const chainId = Number(env.CHAIN_ID);
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  // concurrent reads in one tick fold into a single Multicall3 eth_call
  const pc = createPublicClient({ chain, transport: http(env.RPC_URL), batch: { multicall: true } });
  const local = env.OPERATOR_KEY ? privateKeyToAccount(env.OPERATOR_KEY as Hex) : undefined;
  const wc = local ? createWalletClient({ account: local, chain, transport: http(env.RPC_URL) }) : undefined;
  const privy: (PrivyCreds & { address: Address }) | undefined =
    env.PRIVY_APP_ID && env.PRIVY_APP_SECRET && env.PRIVY_WALLET_ID && env.PRIVY_ADDRESS
      ? { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, walletId: env.PRIVY_WALLET_ID, address: env.PRIVY_ADDRESS as Address }
      : undefined;
  if (!local && !privy) throw new Error("set OPERATOR_KEY or the PRIVY_* variables");
  const taker = env.TAKER_KEY ? privateKeyToAccount(env.TAKER_KEY as Hex) : undefined;
  const tw = taker ? createWalletClient({ account: taker, chain, transport: http(env.RPC_URL) }) : undefined;
  const headroomBps = BigInt(env.GAS_HEADROOM_BPS ?? "500");
  const tipWei = BigInt(Math.round(Number(env.PRIORITY_GWEI ?? "0") * 1e9));
  return { chainId, pc, wc, local, privy, signer: undefined as Signer | undefined, taker, tw, headroomBps, tipWei };
}

type Clients = ReturnType<typeof clients>;
type Signer = { kind: "privy" | "local"; address: Address };

/** Picks the key that is the vault's operator right now: the Privy wallet first, then the local key. */
function pickSigner(c: Clients, operator: Address): Signer | undefined {
  const op = operator.toLowerCase();
  if (c.privy && c.privy.address.toLowerCase() === op) return { kind: "privy", address: c.privy.address };
  if (c.local && c.local.address.toLowerCase() === op) return { kind: "local", address: c.local.address };
  return undefined;
}

/** Agreement state shared by the tick and the health check: two multicalls. */
async function snapshot({ pc }: Clients, vault: Address) {
  const v = { address: vault, abi: vaultAbi } as const;
  const [block, live, finalized, startBlock, endBlock, current, total, heartbeat, operator, paused, balances, open, minSize, ref, terms, scale] =
    await Promise.all([
      pc.readContract({ address: MULTICALL3, abi: blockAbi, functionName: "getBlockNumber" }),
      pc.readContract({ ...v, functionName: "isLive" }),
      pc.readContract({ ...v, functionName: "finalized" }),
      pc.readContract({ ...v, functionName: "startBlock" }),
      pc.readContract({ ...v, functionName: "endBlock" }),
      pc.readContract({ ...v, functionName: "currentEpoch" }),
      pc.readContract({ ...v, functionName: "totalEpochs" }),
      pc.readContract({ ...v, functionName: "heartbeat" }),
      pc.readContract({ ...v, functionName: "operator" }),
      pc.readContract({ ...v, functionName: "venuePaused" }),
      pc.readContract({ ...v, functionName: "marginBalances" }),
      pc.readContract({ ...v, functionName: "openOrders" }),
      pc.readContract({ ...v, functionName: "minOrderSize" }),
      pc.readContract({ ...v, functionName: "priceRef" }),
      pc.readContract({ ...v, functionName: "terms" }),
      pc.readContract({ ...v, functionName: "marketScale" }),
    ]);
  const h = { address: heartbeat, abi: heartbeatAbi } as const;
  const m = { address: terms.market, abi: marketAbi } as const;
  const [status, settled, params, ...orders] = await Promise.all([
    pc.readContract({ ...h, functionName: "status", args: [current] }),
    pc.readContract({ ...h, functionName: "settledEpochs" }),
    pc.readContract({ ...m, functionName: "getMarketParams" }),
    ...open.map((id) => pc.readContract({ ...m, functionName: "orders", args: [id] })),
  ]);
  // what the vault holds in total: free margin plus what its resting quotes lock (released by the next requote)
  let base = balances[0];
  let quote = balances[1];
  for (const [, price, size, isBuy, active] of orders) {
    if (!active) continue;
    if (isBuy) quote += (BigInt(price) * size * 10n ** scale.quoteDecimals) / (scale.pricePrecision * scale.sizePrecision);
    else base += (size * 10n ** scale.baseDecimals) / scale.sizePrecision;
  }
  const lastQuoted = ref.lastMid2 > 0n ? BigInt(ref.lastEpoch) : undefined;
  return {
    block, live, finalized, startBlock, endBlock, current, total, heartbeat, operator, paused, open, minSize, ref, terms, scale,
    status, settled, lastQuoted, inventory: { base, quote }, tickSize: BigInt(params[6] || 1),
  };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** Mid of the reference market (Kuru bestBidAsk is 1e18-scaled; empty bid = uint256.max, empty ask = 0). */
async function referenceMid(env: Env): Promise<number | undefined> {
  try {
    const pc = createPublicClient({ transport: http(env.REF_RPC_URL || "https://rpc.monad.xyz", { timeout: 4_000 }) });
    const [b, a] = await pc.readContract({ address: (env.REF_MARKET || KURU_XAUT0_USDC) as Address, abi: marketAbi, functionName: "bestBidAsk" });
    if (b === 0n || b >= 2n ** 255n || a === 0n) return undefined;
    return (Number(b) + Number(a)) / 2 / 1e18;
  } catch {
    return undefined;
  }
}

export async function tick(env: Env): Promise<TickResult> {
  const c = clients(env);
  const vault = env.VAULT as Address;
  const s = await snapshot(c, vault);
  const epoch = s.current.toString();
  const h = { address: s.heartbeat, abi: heartbeatAbi } as const;
  const v = { address: vault, abi: vaultAbi } as const;
  if (env.PAUSED === "1") return { epoch, action: "paused", detail: "PAUSED=1, not sending" };

  if (!s.live) {
    // after the end everything is permissionless: sign with whichever key the worker has
    c.signer = pickSigner(c, s.operator) ?? (c.local ? { kind: "local", address: c.local.address } : { kind: "privy", address: c.privy!.address });
    if (s.finalized) return { epoch, action: "idle", detail: "agreement finalized" };
    if (s.block < s.endBlock) return { epoch, action: "idle", detail: `starts at block ${s.startBlock}` };
    // 4. ended: pull the quotes, settle the rest in chunks, then finalize (all permissionless)
    if (s.open.length > 0) {
      const tx = await send(c, { ...v, functionName: "cancel" });
      return { epoch, action: "cancelled", detail: `pulled ${s.open.length} resting quotes`, tx };
    }
    if (s.settled < s.total) {
      const target = s.total - s.settled > MAX_SETTLE ? s.settled + MAX_SETTLE - 1n : s.total - 1n;
      const tx = await send(c, { ...h, functionName: "checkEpoch", args: [target] });
      return { epoch, action: "settled", detail: `epochs ${s.settled} to ${target} (agreement ended)`, tx };
    }
    const tx = await send(c, { ...v, functionName: "finalize" });
    return { epoch, action: "finalized", detail: "stream paid out, bond released", tx };
  }
  c.signer = pickSigner(c, s.operator);
  if (!c.signer) {
    const keys = [c.privy?.address, c.local?.address].filter(Boolean).join(", ");
    return { epoch, action: "error", detail: `none of this worker's keys (${keys}) is the vault operator ${s.operator}` };
  }

  // 1. venue paused: excuse the epoch instead of quoting
  if (s.paused) {
    if (!s.terms.pauseExcused || s.status !== 0) return { epoch, action: "skipped", detail: "venue paused" };
    const tx = await send(c, { ...h, functionName: "flagPause" });
    return { epoch, action: "flagged", detail: "venue paused, epoch excused", tx };
  }

  // 2. quote if this epoch has no proof yet
  if (s.status !== QUOTED) return quote(env, c, s, vault);

  // 3. settle once enough ended epochs are waiting (refunds missed bars, pays quoted ones)
  const every = BigInt(env.SETTLE_EVERY ?? "6");
  const lastEnded = s.current - 1n;
  if (lastEnded >= s.settled && lastEnded - s.settled + 1n >= every) {
    const target = lastEnded - s.settled + 1n > MAX_SETTLE ? s.settled + MAX_SETTLE - 1n : lastEnded;
    const tx = await send(c, { ...h, functionName: "checkEpoch", args: [target] });
    return { epoch, action: "settled", detail: `epochs ${s.settled} to ${target}`, tx };
  }

  // 5. idle: let the independent taker trade now and then, so the book sees real fills
  if (c.taker && Math.random() < Number(env.FLOW_PROB ?? 0.2)) return flow(c, s);
  return { epoch, action: "idle", detail: "epoch already quoted" };
}

async function quote(env: Env, c: Clients, s: Snapshot, vault: Address): Promise<TickResult> {
  const epoch = s.current.toString();
  const { terms, scale } = s;
  const pp = Number(scale.pricePrecision);
  const lastMid = s.ref.lastMid2 > 0n ? Number(s.ref.lastMid2) / 2 / pp : undefined;
  const sigma = Number(env.SIGMA_BPS ?? 2) / 1e4;

  // reference: the real market's mid; a random walk from the last proof if it can't be read
  let mid = await referenceMid(env);
  let source = "kuru mainnet";
  if (mid === undefined) {
    const from = lastMid ?? Number(env.INITIAL_MID ?? 4100);
    const dt = (terms.epochBlocks * Number(env.BLOCK_MS ?? 302)) / 1000;
    const z = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    mid = from * Math.exp(sigma * Math.sqrt(dt) * z);
    source = "walk";
  }

  // inventory imbalance: +1 all base, -1 all quote
  const qd = Number(scale.quoteDecimals);
  const bd = Number(scale.baseDecimals);
  const baseQty = Number(s.inventory.base) / 10 ** bd;
  const quoteQty = Number(s.inventory.quote) / 10 ** qd;
  const q = Math.max(-1, Math.min(1, (baseQty * mid - quoteQty) / (baseQty * mid + quoteQty || 1)));

  // Avellaneda-Stoikov in bps, clamped to 85% of the SLA
  const varBps = (sigma * 1e4) ** 2 * 60;
  const gamma = 0.1;
  const k = 1.5;
  const raw = gamma * varBps + (2 / gamma) * Math.log(1 + gamma / k);
  const spreadBps = Math.min(terms.maxSpreadBps * 0.85, Math.max(8, raw));
  const skewBps = Math.max(-spreadBps / 2, Math.min(spreadBps / 2, q * gamma * varBps));
  let r = mid * (1 - skewBps / 1e4);

  // the vault rejects a mid that moved more than maxMidMoveBps per epoch since the last proof: follow the
  // market at up to 80% of that pace
  if (terms.maxMidMoveBps > 0 && lastMid) {
    const gap = Math.max(1, Number(s.current - BigInt(s.ref.lastEpoch)));
    const lim = (0.8 * terms.maxMidMoveBps * gap) / 1e4;
    r = Math.min(lastMid * (1 + lim), Math.max(lastMid * (1 - lim), r));
  }

  const tick = s.tickSize;
  const bid = (BigInt(Math.floor(r * (1 - spreadBps / 2e4) * pp)) / tick) * tick;
  const ask = ((BigInt(Math.ceil(r * (1 + spreadBps / 2e4) * pp)) + tick - 1n) / tick) * tick;
  const target = (terms.minDepthQuote * 125n) / 100n; // depth per side, raw quote units
  const P = scale.pricePrecision;
  const S = scale.sizePrecision;
  const Q = 10n ** scale.quoteDecimals;
  const B = 10n ** scale.baseDecimals;

  // full size, or everything that side has left (the vault accepts a used-up side posted in full)
  let bidSize = (target * P * S) / (bid * Q) + 1n;
  if ((bid * bidSize * Q) / (P * S) > s.inventory.quote) bidSize = (s.inventory.quote * P * S) / (bid * Q);
  let askSize = (target * S) / ((ask * Q) / P) + 1n;
  if ((askSize * B) / S > s.inventory.base) askSize = (s.inventory.base * S) / B;
  const bids = bidSize >= s.minSize ? [Number(bid)] : [];
  const asks = askSize >= s.minSize ? [Number(ask)] : [];
  if (bids.length + asks.length === 0) return { epoch, action: "skipped", detail: "no inventory on either side" };
  if (bids.length + asks.length === 1 && !lastMid) return { epoch, action: "skipped", detail: "first quote needs both sides" };

  const tx = await send(c, {
    address: vault,
    abi: vaultAbi,
    functionName: "requote",
    args: [bids, bids.length ? [bidSize] : [], asks, asks.length ? [askSize] : []],
  });
  const sides = bids.length && asks.length ? "" : bids.length ? " bid only" : " ask only";
  return { epoch, action: "quoted", detail: `${source} mid ${mid.toFixed(2)} spread ${spreadBps.toFixed(1)} bps q ${q.toFixed(2)}${sides}`, tx };
}

/** One market order from the independent taker, or the setup it needs first (test tokens, approvals). */
async function flow(c: Clients, s: Snapshot): Promise<TickResult> {
  const epoch = s.current.toString();
  const { pc, taker, tw } = c;
  if (!taker || !tw) return { epoch, action: "idle", detail: "no taker" };
  const market = s.terms.market;
  const base = { address: s.scale.baseToken, abi: erc20Abi } as const;
  const quoteT = { address: s.scale.quoteToken, abi: erc20Abi } as const;
  const [bal, qBal, bAllow, qAllow, best] = await Promise.all([
    pc.readContract({ ...base, functionName: "balanceOf", args: [taker.address] }),
    pc.readContract({ ...quoteT, functionName: "balanceOf", args: [taker.address] }),
    pc.readContract({ ...base, functionName: "allowance", args: [taker.address, market] }),
    pc.readContract({ ...quoteT, functionName: "allowance", args: [taker.address, market] }),
    pc.readContract({ address: market, abi: marketAbi, functionName: "bestBidAsk" }),
  ]);
  const B = 10n ** s.scale.baseDecimals;
  const Q = 10n ** s.scale.quoteDecimals;
  const viaTaker = (call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => send(c, call, "taker");
  // test tokens are free to mint on testnet; keep a float of both
  if (bal < 5n * B) return { epoch, action: "traded", detail: "taker mints test base", tx: await viaTaker({ ...base, functionName: "mint", args: [taker.address, 50n * B] }) };
  if (qBal < 20_000n * Q) return { epoch, action: "traded", detail: "taker mints test quote", tx: await viaTaker({ ...quoteT, functionName: "mint", args: [taker.address, 200_000n * Q] }) };
  const max = 2n ** 255n;
  if (bAllow < max) return { epoch, action: "traded", detail: "taker approves base", tx: await viaTaker({ ...base, functionName: "approve", args: [market, 2n ** 256n - 1n] }) };
  if (qAllow < max) return { epoch, action: "traded", detail: "taker approves quote", tx: await viaTaker({ ...quoteT, functionName: "approve", args: [market, 2n ** 256n - 1n] }) };

  // random side and size (0.2 to 1.0 units of base) against whatever rests on the book
  const [b18, a18] = best;
  const buy = Math.random() < 0.5;
  const amt = 0.2 + Math.random() * 0.8;
  const P = Number(s.scale.pricePrecision);
  const S = Number(s.scale.sizePrecision);
  if (buy) {
    if (a18 === 0n) return { epoch, action: "idle", detail: "taker: no asks to buy" };
    const quoteSize = BigInt(Math.floor(amt * (Number(a18) / 1e18) * P)); // price-precision units
    const tx = await viaTaker({ address: market, abi: marketAbi, functionName: "placeAndExecuteMarketBuy", args: [quoteSize, 0n, false, false] });
    return { epoch, action: "traded", detail: `taker buys about ${amt.toFixed(2)} at ${(Number(a18) / 1e18).toFixed(2)}`, tx };
  }
  if (b18 === 0n || b18 >= 2n ** 255n) return { epoch, action: "idle", detail: "taker: no bids to sell into" };
  const size = BigInt(Math.floor(amt * S));
  const tx = await viaTaker({ address: market, abi: marketAbi, functionName: "placeAndExecuteMarketSell", args: [size, 0n, false, false] });
  return { epoch, action: "traded", detail: `taker sells ${amt.toFixed(2)} at ${(Number(b18) / 1e18).toFixed(2)}`, tx };
}

/**
 * Estimate (reverts surface here with their reason), then send with a tight gas limit and no tip: Monad bills the
 * whole gas limit at base fee + tip, so both are pure cost. If a tipless send is ever refused, retry once with the
 * RPC's suggested fees so the epoch is not missed.
 */
async function send(
  c: Clients,
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
  who: "operator" | "taker" = "operator",
): Promise<Hex> {
  if (who === "operator" && c.signer?.kind === "privy") return sendViaPrivy(c, call);
  const account = who === "taker" ? c.taker! : c.local!;
  const wallet = who === "taker" ? c.tw! : c.wc!;
  const estimate = await c.pc.estimateContractGas({ ...call, account: account.address } as never);
  const gas = (estimate * (10_000n + c.headroomBps)) / 10_000n;
  const fees = await c.pc.estimateFeesPerGas();
  try {
    return await wallet.writeContract({ ...call, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: c.tipWei } as never);
  } catch (e) {
    if (!/underpriced|priority|fee too low|tip/i.test(e instanceof Error ? e.message : String(e))) throw e;
    return wallet.writeContract({ ...call, gas } as never);
  }
}

/** Privy signs (its policy checks target, function, value and chain first), the tick broadcasts the raw tx. */
async function sendViaPrivy(
  c: Clients,
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
): Promise<Hex> {
  const from = c.privy!.address;
  const data = encodeFunctionData(call as never);
  const [estimate, fees, nonce] = await Promise.all([
    c.pc.estimateGas({ account: from, to: call.address, data }),
    c.pc.estimateFeesPerGas(),
    c.pc.getTransactionCount({ address: from, blockTag: "pending" }),
  ]);
  const raw = await privySignTransaction(c.privy!, {
    to: call.address,
    data,
    chainId: c.chainId,
    nonce,
    gas: (estimate * (10_000n + c.headroomBps)) / 10_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: c.tipWei,
  });
  return c.pc.sendRawTransaction({ serializedTransaction: raw });
}

/** Read-only health for the worker's GET /: `ok` is false once the quoter falls behind, so a monitor can alert. */
export async function status(env: Env) {
  const c = clients(env);
  const vault = env.VAULT as Address;
  const s = await snapshot(c, vault);
  const signer = pickSigner(c, s.operator);
  const [balance, takerBalance] = await Promise.all([
    c.pc.getBalance({ address: s.operator }),
    c.taker ? c.pc.getBalance({ address: c.taker.address }) : Promise.resolve(undefined),
  ]);
  const behind = s.lastQuoted === undefined ? (s.live ? s.current + 1n : 0n) : s.current - s.lastQuoted;
  const unsettled = s.live ? s.current - s.settled : s.block >= s.endBlock ? s.total - s.settled : 0n;
  // the current epoch may still be waiting for its tick; one full epoch without a proof is a failure
  const ok = env.PAUSED === "1" || !s.live || s.paused || (behind <= 1n && signer !== undefined);
  const scale = s.scale;
  return {
    ok,
    paused: env.PAUSED === "1",
    vault,
    live: s.live,
    finalized: s.finalized,
    epoch: s.current.toString(),
    currentEpochQuoted: s.status === QUOTED,
    lastQuotedEpoch: s.lastQuoted?.toString() ?? null,
    epochsBehind: behind.toString(),
    unsettledEpochs: unsettled.toString(),
    lastProvenMid: s.ref.lastMid2 > 0n ? Number(s.ref.lastMid2) / 2 / Number(scale.pricePrecision) : null,
    inventory: {
      base: Number(s.inventory.base) / 10 ** Number(scale.baseDecimals),
      quote: Number(s.inventory.quote) / 10 ** Number(scale.quoteDecimals),
    },
    operator: s.operator,
    signer: signer ? (signer.kind === "privy" ? "privy server wallet (policy-locked)" : "local key") : "none of this worker's keys",
    operatorBalanceMon: Number(balance) / 1e18,
    taker: c.taker?.address ?? null,
    takerBalanceMon: takerBalance === undefined ? null : Number(takerBalance) / 1e18,
  };
}
