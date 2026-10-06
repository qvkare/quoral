import { createPublicClient, http, formatUnits, type Address } from "viem";
import { chainById, getDeployment, blockTimeMs } from "@quoral/shared";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const chain = chainById(CHAIN_ID);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0];
export const ENVIO_URL = process.env.NEXT_PUBLIC_ENVIO_URL || "";
export const BLOCK_MS = blockTimeMs(CHAIN_ID);

// batch: the score reads one proof per bar; JSON-RPC batching keeps that to a single HTTP request per poll.
export const publicClient = createPublicClient({ chain, transport: http(RPC_URL, { batch: { wait: 16 } }) });

export function dep() {
  return getDeployment(CHAIN_ID);
}

export const explorerTx = (h: string) =>
  chain.blockExplorers ? `${chain.blockExplorers.default.url}/tx/${h}` : undefined;
export const explorerAddr = (a: string) =>
  chain.blockExplorers ? `${chain.blockExplorers.default.url}/address/${a}` : undefined;

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "n/a");

export function fmt(v: bigint | undefined, decimals: number, dp = 2) {
  if (v === undefined) return "n/a";
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: Math.min(dp, 2) });
}

export function blocksToDuration(blocks: bigint | number) {
  const s = (Number(blocks) * BLOCK_MS) / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

export const isAddress = (a: string): a is Address => /^0x[0-9a-fA-F]{40}$/.test(a);
