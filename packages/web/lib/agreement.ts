import { erc20Abi, type Address } from "viem";
import {
  inventoryVaultAbi,
  heartbeatAbi,
  paystreamAbi,
  bondVaultAbi,
  disclosureRegistryAbi,
  agreementFactoryAbi,
  rfqAuctionAbi,
} from "@quoral/shared";
import { publicClient, dep } from "./chain";

export type TokenInfo = { address: Address; symbol: string; decimals: number };

const tokenCache = new Map<string, TokenInfo>();
export async function token(address: Address): Promise<TokenInfo> {
  const k = address.toLowerCase();
  if (tokenCache.has(k)) return tokenCache.get(k)!;
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const t = { address, symbol, decimals };
  tokenCache.set(k, t);
  return t;
}

export type AgreementView = Awaited<ReturnType<typeof loadAgreement>>;

/** Everything the public Terms page needs, read straight from the contracts. */
export type Bar = {
  epoch: bigint;
  status: number; // 0 pending, 1 quoted, 2 excused, 3 missed (see Types.sol EpochStatus)
  bid?: number;
  ask?: number;
  spreadBps?: number;
  bidDepth?: bigint;
  askDepth?: bigint;
  block?: bigint;
};

export async function loadAgreement(vault: Address, stripLen = 96, barsLen = 0) {
  const v = { address: vault, abi: inventoryVaultAbi } as const;
  const [terms, scale, issuer, mm, operator, heartbeat, paystream, startBlock, endBlock, noticeGiven, finalized, live, current, total, margin, paused, pendingOperator] =
    await Promise.all([
      publicClient.readContract({ ...v, functionName: "terms" }),
      publicClient.readContract({ ...v, functionName: "marketScale" }),
      publicClient.readContract({ ...v, functionName: "issuer" }),
      publicClient.readContract({ ...v, functionName: "mm" }),
      publicClient.readContract({ ...v, functionName: "operator" }),
      publicClient.readContract({ ...v, functionName: "heartbeat" }),
      publicClient.readContract({ ...v, functionName: "paystream" }),
      publicClient.readContract({ ...v, functionName: "startBlock" }),
      publicClient.readContract({ ...v, functionName: "endBlock" }),
      publicClient.readContract({ ...v, functionName: "noticeGiven" }),
      publicClient.readContract({ ...v, functionName: "finalized" }),
      publicClient.readContract({ ...v, functionName: "isLive" }),
      publicClient.readContract({ ...v, functionName: "currentEpoch" }),
      publicClient.readContract({ ...v, functionName: "totalEpochs" }),
      publicClient.readContract({ ...v, functionName: "marginBalances" }),
      publicClient.readContract({ ...v, functionName: "venuePaused" }),
      publicClient.readContract({ ...v, functionName: "pendingOperator" }),
    ]);
  const h = { address: heartbeat, abi: heartbeatAbi } as const;
  const p = { address: paystream, abi: paystreamAbi } as const;
  const from = current + 1n > BigInt(stripLen) ? current + 1n - BigInt(stripLen) : 0n;
  const count = current + 1n - from;
  const [settled, quotedCount, excusedCount, missedCount, totalSlashed, windowEpochs, allowedMisses, strip, lastProof, prevProof] =
    await Promise.all([
      publicClient.readContract({ ...h, functionName: "settledEpochs" }),
      publicClient.readContract({ ...h, functionName: "quotedCount" }),
      publicClient.readContract({ ...h, functionName: "excusedCount" }),
      publicClient.readContract({ ...h, functionName: "missedCount" }),
      publicClient.readContract({ ...h, functionName: "totalSlashed" }),
      publicClient.readContract({ ...h, functionName: "windowEpochs" }),
      publicClient.readContract({ ...h, functionName: "allowedMisses" }),
      publicClient.readContract({ ...h, functionName: "statusRange", args: [from, count] }),
      publicClient.readContract({ ...h, functionName: "proofs", args: [current] }),
      publicClient.readContract({ ...h, functionName: "proofs", args: [current > 0n ? current - 1n : 0n] }),
    ]);
  const barsFrom = current + 1n > BigInt(barsLen) ? current + 1n - BigInt(barsLen) : 0n;
  const barEpochs = barsLen > 0 ? Array.from({ length: Number(current + 1n - barsFrom) }, (_, i) => barsFrom + BigInt(i)) : [];
  const barProofs = await Promise.all(barEpochs.map((e) => publicClient.readContract({ ...h, functionName: "proofs", args: [e] })));
  const pp = Number(scale.pricePrecision);
  const bars: Bar[] = barEpochs.map((e, i) => {
    const st = Number(strip[Number(e - from)] ?? 0);
    const pr = barProofs[i];
    const has = st === 1 && pr[3] > 0n;
    return {
      epoch: e,
      status: st,
      bid: has ? pr[0] / pp : undefined,
      ask: has ? pr[1] / pp : undefined,
      spreadBps: has ? pr[2] : undefined,
      block: has ? pr[3] : undefined,
      bidDepth: has ? pr[4] : undefined,
      askDepth: has ? pr[5] : undefined,
    };
  });
  const window = current / BigInt(windowEpochs);
  const [uptimeBps, earned, claimed, clawedBack, liveAccrued, refunded, feeBps, retainerPerBlock] = await Promise.all([
    publicClient.readContract({ ...h, functionName: "windowUptimeBps", args: [window] }),
    publicClient.readContract({ ...p, functionName: "earned" }),
    publicClient.readContract({ ...p, functionName: "claimed" }),
    publicClient.readContract({ ...p, functionName: "clawedBack" }),
    publicClient.readContract({ ...p, functionName: "liveAccrued" }),
    publicClient.readContract({ ...p, functionName: "refunded" }),
    publicClient.readContract({ ...p, functionName: "feeBps" }),
    publicClient.readContract({ ...p, functionName: "retainerPerBlock" }),
  ]);
  const d = dep();
  const [bond, disclosure, base, quote, blockNumber] = await Promise.all([
    publicClient.readContract({ address: d.bondVault, abi: bondVaultAbi, functionName: "bonds", args: [vault] }),
    publicClient.readContract({ address: d.registry, abi: disclosureRegistryAbi, functionName: "disclosure", args: [vault] }),
    token(scale.baseToken),
    token(scale.quoteToken),
    publicClient.getBlockNumber(),
  ]);
  const escrow = await publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [paystream] });
  // proof of the live epoch, or the previous one if the bot hasn't quoted yet this epoch
  const proof = lastProof[3] > 0n ? lastProof : prevProof;
  return {
    fetchedAt: Date.now(),
    vault,
    terms,
    scale,
    base,
    quote,
    issuer,
    mm,
    operator,
    pendingOperator,
    heartbeat,
    paystream,
    startBlock,
    endBlock,
    noticeGiven,
    finalized,
    live,
    paused,
    blockNumber,
    epoch: { current, total, settled, from, strip: strip.map(Number), windowEpochs, allowedMisses, window, uptimeBps },
    bars,
    progress: Math.min(1, Math.max(0, Number(blockNumber - startBlock - current * BigInt(terms.epochBlocks)) / terms.epochBlocks)),
    counts: { quoted: quotedCount, excused: excusedCount, missed: missedCount },
    proof: {
      bestBid: proof[0],
      bestAsk: proof[1],
      spreadBps: proof[2],
      blockNumber: proof[3],
      bidDepth: proof[4],
      askDepth: proof[5],
    },
    inventory: { base: margin[0], quote: margin[1] },
    pay: { earned, claimed, clawedBack, liveAccrued, refunded, feeBps, retainerPerBlock, escrow, claimable: earned - claimed },
    bond: { mm: bond[0], amount: bond[2], slashed: bond[3], released: bond[4], totalSlashed },
    disclosure,
  };
}

export async function listAgreements(): Promise<Address[]> {
  const d = dep();
  const n = await publicClient.readContract({ address: d.factory, abi: agreementFactoryAbi, functionName: "agreementCount" });
  return Promise.all(
    Array.from({ length: Number(n) }, (_, i) =>
      publicClient.readContract({ address: d.factory, abi: agreementFactoryAbi, functionName: "agreements", args: [BigInt(i)] }),
    ),
  );
}

/** `/<token>` resolves a base-token address to its latest agreement; an agreement address resolves to itself. */
export async function resolveAgreement(addr: Address): Promise<Address | undefined> {
  const d = dep();
  const list = await publicClient.readContract({ address: d.registry, abi: disclosureRegistryAbi, functionName: "agreementsOf", args: [addr] });
  if (list.length) return list[list.length - 1];
  const disc = await publicClient.readContract({ address: d.registry, abi: disclosureRegistryAbi, functionName: "disclosure", args: [addr] });
  return disc.issuer !== "0x0000000000000000000000000000000000000000" ? addr : undefined;
}

export async function listRFQs() {
  const d = dep();
  const n = await publicClient.readContract({ address: d.rfq, abi: rfqAuctionAbi, functionName: "rfqCount" });
  const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));
  return Promise.all(
    ids.map(async (id) => {
      const [r, bidders] = await Promise.all([
        publicClient.readContract({ address: d.rfq, abi: rfqAuctionAbi, functionName: "rfq", args: [id] }),
        publicClient.readContract({ address: d.rfq, abi: rfqAuctionAbi, functionName: "bidders", args: [id] }),
      ]);
      const bids = await Promise.all(
        bidders.map(async (b) => {
          const [retainerPerBlock, operator, active] = await publicClient.readContract({
            address: d.rfq,
            abi: rfqAuctionAbi,
            functionName: "bids",
            args: [id, b],
          });
          return { bidder: b, retainerPerBlock, operator, active };
        }),
      );
      return { id, ...r, bids };
    }),
  );
}

export const STATUS_LABEL = ["pending", "quoted", "excused", "missed"] as const;
