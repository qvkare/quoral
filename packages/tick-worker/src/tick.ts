/**
 * One stateless tick of the Quoral house quoter and keeper. Runs every minute from a Cloudflare cron trigger
 * (src/index.ts) or in a loop on a laptop (scripts/local.ts).
 *
 * Each tick signs at most one transaction:
 *   1. venue paused and the epoch is unquoted  -> heartbeat.flagPause()
 *   2. the current epoch has no proof          -> vault.requote(one level per side)
 *   3. enough ended epochs are unsettled       -> heartbeat.checkEpoch(last ended)
 *   4. the agreement has ended                 -> vault.cancel(), settle what is left, vault.finalize()
 *   5. nothing to do and TAKER_KEY is set      -> sometimes a market order from an independent taker
 *
 * The operator signs through a policy-locked Privy server wallet when PRIVY_WALLET_ID is set and that wallet is the
 * vault's operator (Privy signs, the tick broadcasts). Otherwise it falls back to OPERATOR_KEY, so the worker keeps
 * quoting across an operator rotation. The vault cancels its own previous quotes inside requote, so the tick needs
 * no order bookkeeping and no logs (Monad's public RPC limits eth_getLogs to 100 blocks).
 *
 * The quoter tracks a real market: the mid of Kuru's XAUt0-USDC book on Monad mainnet (REF_MARKET on
 * REF_RPC_URL), clamped to the agreement's per-epoch drift cap. Quotes follow Avellaneda-Stoikov with an
 * inventory skew; when one side's inventory is used up the vault accepts everything left of it, or no quote
 * on that side at all (InventoryLimited).
 *
 * CPU: Workers on the free plan get about 10 ms of CPU per invocation. Reads and writes go through src/rpc.ts
 * (constant selectors, word-by-word ABI coding) instead of viem, values that never change are cached for the
 * life of the isolate, and viem is loaded only for the paths that sign locally (src/local-signer.ts).
 * The public Monad testnet RPC allows 15 requests per second and counts every call inside a JSON-RPC batch, so
 * the reads go through Multicall3: a quoting tick makes about seven requests in total.
 */
import { privySignTransaction, type PrivyCreds } from "@quoral/shared/privy";
import { aggregate3, addr, bool, calldata, calldataArrays, decodeAggregate3, ethCall, num, rpc, uint, uintArray, words, type Address, type Call, type Hex } from "./rpc";

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

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const KURU_XAUT0_USDC = "0x851145eaeFdc37956B08dA829fa31722199F3f07" as Address;

// selectors (cast sig)
const SEL = {
  blockNumber: "0x42cbb15c", // Multicall3.getBlockNumber()
  isLive: "0xb8f7a665",
  finalized: "0xb3f05b97",
  startBlock: "0x48cd4cb1",
  endBlock: "0x083c6323",
  currentEpoch: "0x76671808",
  totalEpochs: "0x6c5ec94d",
  heartbeat: "0x3defb962",
  operator: "0x570ca735",
  venuePaused: "0x5594508a",
  marginBalances: "0x0332b5c4",
  openOrders: "0xb0ece8fb",
  minOrderSize: "0xa674537f",
  priceRef: "0x8db012fa",
  terms: "0xd5025625",
  marketScale: "0x2d51f757",
  requote: "0xa179649f",
  cancel: "0xea8a1af0",
  finalize: "0x4bb278f3",
  status: "0x42d21ef7",
  settledEpochs: "0x204552ff",
  checkEpoch: "0x9fd13b32",
  flagPause: "0xa7d06ba9",
  getMarketParams: "0x90c9427c",
  bestBidAsk: "0xb4de8b70",
  orders: "0xcbb188d2",
} as const;

const QUOTED = 1;
const MAX_SETTLE = 500n; // epochs settled per transaction

export type TickResult = {
  epoch?: string;
  action: "idle" | "quoted" | "settled" | "flagged" | "cancelled" | "finalized" | "skipped" | "paused" | "traded" | "error";
  detail: string;
  tx?: Hex;
};

type Terms = {
  market: Address;
  maxSpreadBps: number;
  minDepthQuote: bigint;
  epochBlocks: number;
  pauseExcused: boolean;
  maxMidMoveBps: number;
};
type Scale = { pricePrecision: bigint; sizePrecision: bigint; baseDecimals: bigint; quoteDecimals: bigint; baseToken: Address; quoteToken: Address };
type Static = { heartbeat: Address; terms: Terms; scale: Scale; startBlock: bigint; minSize: bigint; tickSize: bigint };

/** Values that never change for an agreement, kept for the life of the isolate. */
const statics = new Map<string, Static>();

type Ctx = {
  env: Env;
  url: string;
  chainId: number;
  vault: Address;
  privy?: PrivyCreds & { address: Address };
  headroomBps: bigint;
  tipWei: bigint;
  signer?: "privy" | "local";
};

function ctx(env: Env): Ctx {
  const privy =
    env.PRIVY_APP_ID && env.PRIVY_APP_SECRET && env.PRIVY_WALLET_ID && env.PRIVY_ADDRESS
      ? { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, walletId: env.PRIVY_WALLET_ID, address: env.PRIVY_ADDRESS as Address }
      : undefined;
  if (!env.OPERATOR_KEY && !privy) throw new Error("set OPERATOR_KEY or the PRIVY_* variables");
  return {
    env,
    url: env.RPC_URL,
    chainId: Number(env.CHAIN_ID),
    vault: env.VAULT as Address,
    privy,
    headroomBps: BigInt(env.GAS_HEADROOM_BPS ?? "500"),
    tipWei: BigInt(Math.round(Number(env.PRIORITY_GWEI ?? "0") * 1e9)),
  };
}

const local = () => import("./local-signer");

/** The key that is the vault's operator right now: the Privy wallet first, then the local key. */
async function pickSigner(c: Ctx, operator: Address): Promise<"privy" | "local" | undefined> {
  const op = operator.toLowerCase();
  if (c.privy && c.privy.address.toLowerCase() === op) return "privy";
  if (c.env.OPERATOR_KEY && (await local()).localAddress(c.env.OPERATOR_KEY).toLowerCase() === op) return "local";
  return undefined;
}

const multicall = async (c: Ctx, calls: Call[]) => decodeAggregate3(await ethCall(c.url, MULTICALL3, aggregate3(calls)));

/** Agreement state shared by the tick and the health check: two multicalls (one once the statics are cached). */
async function snapshot(c: Ctx) {
  const v = c.vault;
  const vc = (sel: string): Call => ({ to: v, data: calldata(sel) });
  let st = statics.get(v.toLowerCase());
  const dyn = [
    { to: MULTICALL3, data: calldata(SEL.blockNumber) },
    vc(SEL.isLive),
    vc(SEL.finalized),
    vc(SEL.endBlock),
    vc(SEL.currentEpoch),
    vc(SEL.totalEpochs),
    vc(SEL.operator),
    vc(SEL.venuePaused),
    vc(SEL.marginBalances),
    vc(SEL.openOrders),
    vc(SEL.priceRef),
  ];
  const once = st ? [] : [vc(SEL.heartbeat), vc(SEL.terms), vc(SEL.marketScale), vc(SEL.startBlock), vc(SEL.minOrderSize)];
  const r = await multicall(c, [...dyn, ...once]);
  const [block, live, finalized, endBlock, current, total, operator, paused] = [
    uint(r[0]),
    bool(r[1]),
    bool(r[2]),
    uint(r[3]),
    uint(r[4]),
    uint(r[5]),
    addr(r[6]),
    bool(r[7]),
  ];
  const mb = words(r[8]);
  const open = uintArray(r[9]);
  const pr = words(r[10]);
  const ref = { lastMid2: uint(pr[0]), lastEpoch: uint(pr[1]), anchorMid2: uint(pr[2]) };

  if (!st) {
    const t = words(r[12]);
    const s = words(r[13]);
    const terms: Terms = {
      market: addr(t[0]),
      maxSpreadBps: num(t[3]),
      minDepthQuote: uint(t[4]),
      epochBlocks: num(t[5]),
      pauseExcused: bool(t[13]),
      maxMidMoveBps: num(t[14]),
    };
    const scale: Scale = { pricePrecision: uint(s[0]), sizePrecision: uint(s[1]), baseDecimals: uint(s[2]), quoteDecimals: uint(s[3]), baseToken: addr(s[4]), quoteToken: addr(s[5]) };
    const params = words(await ethCall(c.url, terms.market, calldata(SEL.getMarketParams)));
    st = { heartbeat: addr(r[11]), terms, scale, startBlock: uint(r[14]), minSize: uint(r[15]), tickSize: uint(params[6]) || 1n };
    statics.set(v.toLowerCase(), st);
  }

  const { heartbeat, terms, scale } = st;
  const r2 = await multicall(c, [
    { to: heartbeat, data: calldata(SEL.status, current) },
    { to: heartbeat, data: calldata(SEL.settledEpochs) },
    ...open.map((id) => ({ to: terms.market, data: calldata(SEL.orders, id) })),
  ]);
  const status = num(r2[0]);
  const settled = uint(r2[1]);
  // what the vault holds in total: free margin plus what its resting quotes lock (released by the next requote)
  let base = uint(mb[0]);
  let quote = uint(mb[1]);
  for (const o of r2.slice(2)) {
    const w = words(o);
    if (!bool(w[4])) continue; // active
    const price = uint(w[1]);
    const size = uint(w[2]);
    if (bool(w[3])) quote += (price * size * 10n ** scale.quoteDecimals) / (scale.pricePrecision * scale.sizePrecision);
    else base += (size * 10n ** scale.baseDecimals) / scale.sizePrecision;
  }
  const lastQuoted = ref.lastMid2 > 0n ? ref.lastEpoch : undefined;
  return { ...st, block, live, finalized, endBlock, current, total, operator, paused, open, ref, status, settled, lastQuoted, inventory: { base, quote } };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** Mid of the reference market (Kuru bestBidAsk is 1e18-scaled; empty bid = uint256.max, empty ask = 0). */
async function referenceMid(env: Env): Promise<number | undefined> {
  try {
    const ret = await Promise.race([
      ethCall(env.REF_RPC_URL || "https://rpc.monad.xyz", (env.REF_MARKET || KURU_XAUT0_USDC) as Address, calldata(SEL.bestBidAsk)),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), 4_000)),
    ]);
    const [w0, w1] = words(ret);
    const b = uint(w0);
    const a = uint(w1);
    if (b === 0n || b >= 2n ** 255n || a === 0n) return undefined;
    return (Number(b) + Number(a)) / 2 / 1e18;
  } catch {
    return undefined;
  }
}

export async function tick(env: Env): Promise<TickResult> {
  const c = ctx(env);
  const s = await snapshot(c);
  const epoch = s.current.toString();
  const v = c.vault;
  const h = s.heartbeat;

  if (env.PAUSED === "1") return { epoch, action: "paused", detail: "PAUSED=1, not sending" };

  if (!s.live) {
    if (s.finalized) return { epoch, action: "idle", detail: "agreement finalized" };
    if (s.block < s.endBlock) return { epoch, action: "idle", detail: `starts at block ${s.startBlock}` };
    // 4. ended: pull the quotes, settle the rest in chunks, then finalize (all permissionless)
    c.signer = (await pickSigner(c, s.operator)) ?? (env.OPERATOR_KEY ? "local" : "privy");
    if (s.open.length > 0) {
      const tx = await send(c, v, calldata(SEL.cancel));
      return { epoch, action: "cancelled", detail: `pulled ${s.open.length} resting quotes`, tx };
    }
    if (s.settled < s.total) {
      const target = s.total - s.settled > MAX_SETTLE ? s.settled + MAX_SETTLE - 1n : s.total - 1n;
      const tx = await send(c, h, calldata(SEL.checkEpoch, target));
      return { epoch, action: "settled", detail: `epochs ${s.settled} to ${target} (agreement ended)`, tx };
    }
    const tx = await send(c, v, calldata(SEL.finalize));
    return { epoch, action: "finalized", detail: "stream paid out, bond released", tx };
  }

  c.signer = await pickSigner(c, s.operator);
  if (!c.signer) return { epoch, action: "error", detail: `none of this worker's keys is the vault operator ${s.operator}` };

  // 1. venue paused: excuse the epoch instead of quoting
  if (s.paused) {
    if (!s.terms.pauseExcused || s.status !== 0) return { epoch, action: "skipped", detail: "venue paused" };
    const tx = await send(c, h, calldata(SEL.flagPause));
    return { epoch, action: "flagged", detail: "venue paused, epoch excused", tx };
  }

  // 2. quote if this epoch has no proof yet
  if (s.status !== QUOTED) return quote(c, s);

  // 3. settle once enough ended epochs are waiting (refunds missed bars, pays quoted ones)
  const every = BigInt(env.SETTLE_EVERY ?? "6");
  const lastEnded = s.current - 1n;
  if (lastEnded >= s.settled && lastEnded - s.settled + 1n >= every) {
    const target = lastEnded - s.settled + 1n > MAX_SETTLE ? s.settled + MAX_SETTLE - 1n : lastEnded;
    const tx = await send(c, h, calldata(SEL.checkEpoch, target));
    return { epoch, action: "settled", detail: `epochs ${s.settled} to ${target}`, tx };
  }

  // 5. idle: let the independent taker trade now and then, so the book sees real fills
  if (env.TAKER_KEY && Math.random() < Number(env.FLOW_PROB ?? 0.2)) {
    const r = await (await local()).takerFlow({
      key: env.TAKER_KEY,
      chainId: c.chainId,
      url: c.url,
      market: s.terms.market,
      base: s.scale.baseToken,
      quote: s.scale.quoteToken,
      baseDecimals: s.scale.baseDecimals,
      quoteDecimals: s.scale.quoteDecimals,
      pricePrecision: s.scale.pricePrecision,
      sizePrecision: s.scale.sizePrecision,
      headroomBps: c.headroomBps,
      tipWei: c.tipWei,
    });
    return { epoch, action: r.tx ? "traded" : "idle", ...r };
  }
  return { epoch, action: "idle", detail: "epoch already quoted" };
}

async function quote(c: Ctx, s: Snapshot): Promise<TickResult> {
  const env = c.env;
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
    const gap = Math.max(1, Number(s.current - s.ref.lastEpoch));
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

  const bids = bidSize >= s.minSize ? [bid] : [];
  const asks = askSize >= s.minSize ? [ask] : [];
  if (bids.length + asks.length === 0) return { epoch, action: "skipped", detail: "no inventory on either side" };
  if (bids.length + asks.length === 1 && !lastMid) return { epoch, action: "skipped", detail: "first quote needs both sides" };

  const data = calldataArrays(SEL.requote, [bids, bids.length ? [bidSize] : [], asks, asks.length ? [askSize] : []]);
  const tx = await send(c, c.vault, data);
  const sides = bids.length && asks.length ? "" : bids.length ? " bid only" : " ask only";
  return { epoch, action: "quoted", detail: `${source} mid ${mid.toFixed(2)} spread ${spreadBps.toFixed(1)} bps q ${q.toFixed(2)}${sides}`, tx };
}

/**
 * Sends one operator transaction. Privy path: estimate, then Privy signs (its policy checks target, function, value
 * and chain first) and the tick broadcasts the raw transaction. Monad bills the whole gas limit at base fee + tip,
 * so the limit carries only GAS_HEADROOM_BPS over the estimate and the tip is PRIORITY_GWEI (default 0).
 */
async function send(c: Ctx, to: Address, data: Hex): Promise<Hex> {
  if (c.signer !== "privy") return (await local()).sendLocal(c.env.OPERATOR_KEY!, c.chainId, c.url, to, data, c.headroomBps, c.tipWei);
  const from = c.privy!.address;
  const [estimate, gasPrice, nonce] = await Promise.all([
    rpc<Hex>(c.url, "eth_estimateGas", [{ from, to, data }]),
    rpc<Hex>(c.url, "eth_gasPrice", []),
    rpc<Hex>(c.url, "eth_getTransactionCount", [from, "pending"]),
  ]);
  const raw = await privySignTransaction(c.privy!, {
    to,
    data,
    chainId: c.chainId,
    nonce: Number(nonce),
    gas: (BigInt(estimate) * (10_000n + c.headroomBps)) / 10_000n,
    maxFeePerGas: (BigInt(gasPrice) * 3n) / 2n, // only base fee + tip is charged; this is the ceiling
    maxPriorityFeePerGas: c.tipWei,
  });
  return rpc<Hex>(c.url, "eth_sendRawTransaction", [raw]);
}

/** Read-only health for the worker's GET /: `ok` is false once the quoter falls behind, so a monitor can alert. */
export async function status(env: Env) {
  const c = ctx(env);
  const s = await snapshot(c);
  const signer = await pickSigner(c, s.operator);
  const [balance, takerBalance] = await Promise.all([
    rpc<Hex>(c.url, "eth_getBalance", [s.operator, "latest"]),
    env.TAKER_KEY ? local().then((m) => rpc<Hex>(c.url, "eth_getBalance", [m.localAddress(env.TAKER_KEY!), "latest"])) : Promise.resolve(undefined),
  ]);
  const behind = s.lastQuoted === undefined ? (s.live ? s.current + 1n : 0n) : s.current - s.lastQuoted;
  const unsettled = s.live ? s.current - s.settled : s.block >= s.endBlock ? s.total - s.settled : 0n;
  // the current epoch may still be waiting for its tick; one full epoch without a proof is a failure
  const ok = env.PAUSED === "1" || !s.live || s.paused || (behind <= 1n && signer !== undefined);
  return {
    ok,
    paused: env.PAUSED === "1",
    vault: c.vault,
    live: s.live,
    finalized: s.finalized,
    epoch: s.current.toString(),
    currentEpochQuoted: s.status === QUOTED,
    lastQuotedEpoch: s.lastQuoted?.toString() ?? null,
    epochsBehind: behind.toString(),
    unsettledEpochs: unsettled.toString(),
    lastProvenMid: s.ref.lastMid2 > 0n ? Number(s.ref.lastMid2) / 2 / Number(s.scale.pricePrecision) : null,
    inventory: {
      base: Number(s.inventory.base) / 10 ** Number(s.scale.baseDecimals),
      quote: Number(s.inventory.quote) / 10 ** Number(s.scale.quoteDecimals),
    },
    operator: s.operator,
    signer: signer ? (signer === "privy" ? "privy server wallet (policy-locked)" : "local key") : "none of this worker's keys",
    operatorBalanceMon: Number(BigInt(balance)) / 1e18,
    takerBalanceMon: takerBalance === undefined ? null : Number(BigInt(takerBalance)) / 1e18,
  };
}
