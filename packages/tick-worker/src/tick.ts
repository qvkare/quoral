/**
 * One stateless tick of the Quoral house quoter and keeper. Runs every minute from a Cloudflare cron trigger
 * (src/index.ts) or in a loop on a laptop (scripts/local.ts).
 *
 * Each tick signs at most one transaction, to stay inside the Workers CPU budget:
 *   1. venue paused and the epoch is unquoted  -> heartbeat.flagPause()
 *   2. the current epoch has no proof          -> vault.requote(one level per side)
 *   3. enough ended epochs are unsettled       -> heartbeat.checkEpoch(last ended)
 * The vault cancels its own previous quotes inside requote, so the tick needs no order bookkeeping and no logs
 * (Monad's public RPC limits eth_getLogs to 100 blocks).
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Env = {
  RPC_URL: string;
  CHAIN_ID: string;
  VAULT: string;
  OPERATOR_KEY: string;
  SETTLE_EVERY?: string; // settle once this many ended epochs are waiting (default 10)
  SIGMA_BPS?: string; // reference volatility per sqrt(second), in bps (default 2)
  BLOCK_MS?: string; // for the reference random walk (default 306)
  INITIAL_MID?: string; // reference price before the first proof (default 3900)
};

const vaultAbi = parseAbi([
  "function isLive() view returns (bool)",
  "function currentEpoch() view returns (uint256)",
  "function heartbeat() view returns (address)",
  "function operator() view returns (address)",
  "function venuePaused() view returns (bool)",
  "function marginBalances() view returns (uint256 base, uint256 quote)",
  "function terms() view returns ((address market, uint256 baseInventory, uint256 quoteInventory, uint16 maxSpreadBps, uint256 minDepthQuote, uint32 epochBlocks, uint32 uptimeWindowEpochs, uint16 uptimeBps, uint256 retainerPerBlock, uint64 durationBlocks, uint64 noticeBlocks, uint256 bondAmount, uint256 slashAmount, bool pauseExcused))",
  "function marketScale() view returns ((uint256 pricePrecision, uint256 sizePrecision, uint256 baseDecimals, uint256 quoteDecimals, address baseToken, address quoteToken))",
  "function requote(uint32[] bidPrices, uint96[] bidSizes, uint32[] askPrices, uint96[] askSizes) returns (uint256)",
]);
const heartbeatAbi = parseAbi([
  "function status(uint256 epoch) view returns (uint8)",
  "function settledEpochs() view returns (uint256)",
  "function proofs(uint256 epoch) view returns (uint32 bestBid, uint32 bestAsk, uint16 spreadBps, uint64 blockNumber, uint128 bidDepthQuote, uint128 askDepthQuote)",
  "function checkEpoch(uint256 epoch)",
  "function flagPause() returns (uint256)",
]);
const marketAbi = parseAbi([
  "function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
]);

const QUOTED = 1;
const LOOKBACK = 12; // epochs searched for the last proof

export type TickResult = {
  epoch?: string;
  action: "idle" | "quoted" | "settled" | "flagged" | "skipped" | "error";
  detail: string;
  tx?: Hex;
};

export async function tick(env: Env): Promise<TickResult> {
  const chainId = Number(env.CHAIN_ID);
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });
  const transport = http(env.RPC_URL, { batch: true });
  const pc = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(env.OPERATOR_KEY as Hex);
  const wc = createWalletClient({ account, chain, transport: http(env.RPC_URL) });
  const vault = env.VAULT as Address;
  const v = { address: vault, abi: vaultAbi } as const;

  const [live, current, heartbeat, operator, paused, balances, terms, scale] = await Promise.all([
    pc.readContract({ ...v, functionName: "isLive" }),
    pc.readContract({ ...v, functionName: "currentEpoch" }),
    pc.readContract({ ...v, functionName: "heartbeat" }),
    pc.readContract({ ...v, functionName: "operator" }),
    pc.readContract({ ...v, functionName: "venuePaused" }),
    pc.readContract({ ...v, functionName: "marginBalances" }),
    pc.readContract({ ...v, functionName: "terms" }),
    pc.readContract({ ...v, functionName: "marketScale" }),
  ]);
  if (!live) return { action: "idle", detail: "agreement is not live" };
  if (operator.toLowerCase() !== account.address.toLowerCase()) {
    return { action: "error", detail: `this key ${account.address} is not the vault operator ${operator}` };
  }
  const h = { address: heartbeat, abi: heartbeatAbi } as const;
  const lookback = Array.from({ length: Math.min(LOOKBACK, Number(current) + 1) }, (_, i) => current - BigInt(i));
  const [status, settled, ...proofs] = await Promise.all([
    pc.readContract({ ...h, functionName: "status", args: [current] }),
    pc.readContract({ ...h, functionName: "settledEpochs" }),
    ...lookback.map((e) => pc.readContract({ ...h, functionName: "proofs", args: [e] })),
  ]);
  const epoch = current.toString();

  // 1. venue paused: excuse the epoch instead of quoting
  if (paused) {
    if (!terms.pauseExcused || status !== 0) return { epoch, action: "skipped", detail: "venue paused" };
    const tx = await send(pc, wc, account.address, { ...h, functionName: "flagPause" });
    return { epoch, action: "flagged", detail: "venue paused, epoch excused", tx };
  }

  // 2. quote if this epoch has no proof yet
  if (status !== QUOTED) {
    const pp = Number(scale.pricePrecision);
    const last = proofs.find((p) => p[3] > 0n);
    const lastMid = last ? (Number(last[0]) + Number(last[1])) / 2 / pp : Number(env.INITIAL_MID ?? 3900);
    // reference: geometric random walk from the last proven mid, one step per epoch
    const sigma = Number(env.SIGMA_BPS ?? 2) / 1e4;
    const dt = (terms.epochBlocks * Number(env.BLOCK_MS ?? 306)) / 1000;
    const z = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    const mid = lastMid * Math.exp(sigma * Math.sqrt(dt) * z);

    // inventory: free margin plus what the last quote set has locked (released by the auto-cancel)
    const qd = Number(scale.quoteDecimals);
    const bd = Number(scale.baseDecimals);
    const lockedQuote = last ? Number(last[4]) / 10 ** qd : 0;
    const lockedBase = last ? Number(last[5]) / 10 ** qd / (Number(last[1]) / pp) : 0;
    const baseQty = Number(balances[0]) / 10 ** bd + lockedBase;
    const quoteQty = Number(balances[1]) / 10 ** qd + lockedQuote;
    const q = Math.max(-1, Math.min(1, (baseQty * mid - quoteQty) / (baseQty * mid + quoteQty || 1)));

    // Avellaneda-Stoikov in bps, clamped to 85% of the SLA, one level per side
    const varBps = (sigma * 1e4) ** 2 * 60;
    const gamma = 0.1;
    const k = 1.5;
    const raw = gamma * varBps + (2 / gamma) * Math.log(1 + gamma / k);
    const spreadBps = Math.min(terms.maxSpreadBps * 0.85, Math.max(8, raw));
    const skewBps = Math.max(-spreadBps / 2, Math.min(spreadBps / 2, q * gamma * varBps));
    const r = mid * (1 - skewBps / 1e4);
    const [, , , , , , tickSize, minSize] = await pc.readContract({ address: terms.market, abi: marketAbi, functionName: "getMarketParams" });
    const tick = Number(tickSize) || 1;
    const bid = Math.floor((r * (1 - spreadBps / 2e4) * pp) / tick) * tick;
    const ask = Math.ceil((r * (1 + spreadBps / 2e4) * pp) / tick) * tick;
    const notional = (Number(terms.minDepthQuote) / 10 ** qd) * 1.25;
    const sp = Number(scale.sizePrecision);
    const size = (px: number) => {
      const s = BigInt(Math.ceil((notional / (px / pp)) * sp)) + 1n;
      return s < minSize ? minSize : s;
    };
    const bidSize = size(bid);
    const askSize = size(ask);
    const needQuote = (bid / pp) * (Number(bidSize) / sp);
    const needBase = Number(askSize) / sp;
    if (needQuote > quoteQty || needBase > baseQty) {
      return { epoch, action: "skipped", detail: `inventory exhausted: need ${needBase.toFixed(4)} base and ${needQuote.toFixed(2)} quote` };
    }
    const tx = await send(pc, wc, account.address, {
      ...v,
      functionName: "requote",
      args: [[bid], [bidSize], [ask], [askSize]],
    });
    return { epoch, action: "quoted", detail: `mid ${mid.toFixed(2)} spread ${spreadBps.toFixed(1)} bps q ${q.toFixed(2)}`, tx };
  }

  // 3. settle once enough ended epochs are waiting (refunds missed bars, pays quoted ones)
  const every = BigInt(env.SETTLE_EVERY ?? "10");
  const lastEnded = current - 1n;
  if (lastEnded >= settled && lastEnded - settled + 1n >= every) {
    const tx = await send(pc, wc, account.address, { ...h, functionName: "checkEpoch", args: [lastEnded] });
    return { epoch, action: "settled", detail: `epochs ${settled} to ${lastEnded}`, tx };
  }
  return { epoch, action: "idle", detail: "epoch already quoted" };
}

/** Simulate, then send with a tight gas limit: Monad charges the gas limit, not the gas used. */
async function send(
  pc: ReturnType<typeof createPublicClient>,
  wc: ReturnType<typeof createWalletClient>,
  from: Address,
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
): Promise<Hex> {
  const req = { ...call, account: from } as never;
  await pc.simulateContract(req);
  const gas = await pc.estimateContractGas(req);
  return wc.writeContract({ ...(call as object), gas: (gas * 115n) / 100n } as never);
}

/** Read-only status for the worker's health endpoint. */
export async function status(env: Env) {
  const chain = defineChain({
    id: Number(env.CHAIN_ID),
    name: "chain",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });
  const pc = createPublicClient({ chain, transport: http(env.RPC_URL, { batch: true }) });
  const account = privateKeyToAccount(env.OPERATOR_KEY as Hex);
  const v = { address: env.VAULT as Address, abi: vaultAbi } as const;
  const [live, current, heartbeat, balance] = await Promise.all([
    pc.readContract({ ...v, functionName: "isLive" }),
    pc.readContract({ ...v, functionName: "currentEpoch" }),
    pc.readContract({ ...v, functionName: "heartbeat" }),
    pc.getBalance({ address: account.address }),
  ]);
  const h = { address: heartbeat, abi: heartbeatAbi } as const;
  const [st, settled] = await Promise.all([
    pc.readContract({ ...h, functionName: "status", args: [current] }),
    pc.readContract({ ...h, functionName: "settledEpochs" }),
  ]);
  return {
    vault: env.VAULT,
    live,
    epoch: current.toString(),
    currentEpochQuoted: st === QUOTED,
    settledThrough: (settled > 0n ? settled - 1n : 0n).toString(),
    operator: account.address,
    operatorBalanceMon: Number(balance) / 1e18,
  };
}
