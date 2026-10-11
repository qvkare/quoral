/**
 * The paths that sign locally: the OPERATOR_KEY fallback and the independent test taker. They need viem's
 * secp256k1 signing, so tick.ts imports this module only when one of them runs; a normal tick (Privy signs) never
 * loads viem at all.
 */
import { createWalletClient, defineChain, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { calldata, ethCall, rpc, words, uint, type Address } from "./rpc";

const chainOf = (id: number, url: string) =>
  defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [url] } } });

/** Estimate (reverts surface here), then send with a tight gas limit and the given tip. */
export async function sendLocal(key: string, chainId: number, url: string, to: Address, data: Hex, headroomBps: bigint, tipWei: bigint): Promise<Hex> {
  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: chainOf(chainId, url), transport: http(url) });
  const [estimate, gasPrice] = await Promise.all([
    rpc<Hex>(url, "eth_estimateGas", [{ from: account.address, to, data }]),
    rpc<Hex>(url, "eth_gasPrice", []),
  ]);
  const gas = (BigInt(estimate) * (10_000n + headroomBps)) / 10_000n;
  const maxFeePerGas = (BigInt(gasPrice) * 3n) / 2n;
  try {
    return await wallet.sendTransaction({ to, data, gas, maxFeePerGas, maxPriorityFeePerGas: tipWei });
  } catch (e) {
    if (!/underpriced|priority|fee too low|tip/i.test(e instanceof Error ? e.message : String(e))) throw e;
    return wallet.sendTransaction({ to, data, gas });
  }
}

export const localAddress = (key: string) => privateKeyToAccount(key as Hex).address;

const takerAbi = parseAbi([
  "function mint(address, uint256)",
  "function approve(address, uint256) returns (bool)",
  "function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
]);

type FlowInput = {
  key: string;
  chainId: number;
  url: string;
  market: Address;
  base: Address;
  quote: Address;
  baseDecimals: bigint;
  quoteDecimals: bigint;
  pricePrecision: bigint;
  sizePrecision: bigint;
  headroomBps: bigint;
  tipWei: bigint;
};

/** One market order from the independent taker, or the setup it needs first (test tokens, approvals). */
export async function takerFlow(f: FlowInput): Promise<{ detail: string; tx?: Hex }> {
  const { encodeFunctionData } = await import("viem");
  const me = localAddress(f.key);
  const send = (to: Address, data: Hex) => sendLocal(f.key, f.chainId, f.url, to, data, f.headroomBps, f.tipWei);
  const pad = me.slice(2).toLowerCase().padStart(64, "0");
  const mkt = f.market.slice(2).toLowerCase().padStart(64, "0");
  const [bal, qBal, bAllow, qAllow, best] = await Promise.all([
    ethCall(f.url, f.base, `0x70a08231${pad}`),
    ethCall(f.url, f.quote, `0x70a08231${pad}`),
    ethCall(f.url, f.base, `0xdd62ed3e${pad}${mkt}`),
    ethCall(f.url, f.quote, `0xdd62ed3e${pad}${mkt}`),
    ethCall(f.url, f.market, calldata("0xb4de8b70")),
  ]);
  const B = 10n ** f.baseDecimals;
  const Q = 10n ** f.quoteDecimals;
  const max = 2n ** 255n;
  const call = (to: Address, functionName: string, args: readonly unknown[]) => send(to, encodeFunctionData({ abi: takerAbi, functionName, args } as never));
  // test tokens are free to mint on testnet; keep a float of both
  if (BigInt(bal) < 5n * B) return { detail: "taker mints test base", tx: await call(f.base, "mint", [me, 50n * B]) };
  if (BigInt(qBal) < 20_000n * Q) return { detail: "taker mints test quote", tx: await call(f.quote, "mint", [me, 200_000n * Q]) };
  if (BigInt(bAllow) < max) return { detail: "taker approves base", tx: await call(f.base, "approve", [f.market, 2n ** 256n - 1n]) };
  if (BigInt(qAllow) < max) return { detail: "taker approves quote", tx: await call(f.quote, "approve", [f.market, 2n ** 256n - 1n]) };
  // random side and size (0.2 to 1.0 units of base) against whatever rests on the book
  const [w0, w1] = words(best);
  const b18 = uint(w0);
  const a18 = uint(w1);
  const buy = Math.random() < 0.5;
  const amt = 0.2 + Math.random() * 0.8;
  if (buy) {
    if (a18 === 0n) return { detail: "taker: no asks to buy" };
    const quoteSize = BigInt(Math.floor(amt * (Number(a18) / 1e18) * Number(f.pricePrecision)));
    const tx = await call(f.market, "placeAndExecuteMarketBuy", [quoteSize, 0n, false, false]);
    return { detail: `taker buys about ${amt.toFixed(2)} at ${(Number(a18) / 1e18).toFixed(2)}`, tx };
  }
  if (b18 === 0n || b18 >= 2n ** 255n) return { detail: "taker: no bids to sell into" };
  const tx = await call(f.market, "placeAndExecuteMarketSell", [BigInt(Math.floor(amt * Number(f.sizePrecision))), 0n, false, false]);
  return { detail: `taker sells ${amt.toFixed(2)} at ${(Number(b18) / 1e18).toFixed(2)}`, tx };
}
