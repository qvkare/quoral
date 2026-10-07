import { createPublicClient, http, formatUnits, type Address } from "viem";
import { chainById, getDeployment, blockTimeMs } from "@quoral/shared";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const chain = chainById(CHAIN_ID);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0];
export const ENVIO_URL = process.env.NEXT_PUBLIC_ENVIO_URL || "";
export const BLOCK_MS = blockTimeMs(CHAIN_ID);

// The score reads one proof per bar. On Monad, Multicall3 folds every read of a poll into one eth_call;
// the local anvil chain has no Multicall3, so there JSON-RPC batching does the same job.
const hasMulticall = Boolean((chain as { contracts?: { multicall3?: unknown } }).contracts?.multicall3);
export const publicClient = createPublicClient({
  chain,
  batch: hasMulticall ? { multicall: { wait: 16 } } : undefined,
  transport: http(RPC_URL, { batch: hasMulticall ? false : { wait: 16 } }),
});

/** Where the agreement quotes. Kuru's testnet runs v2, so the testnet demo uses a book with the Kuru v1 interface. */
export const VENUE =
  CHAIN_ID === 143
    ? { name: "Kuru", note: "" }
    : CHAIN_ID === 10143
      ? {
          name: "a Kuru v1-compatible test book",
          note: "Monad testnet. Kuru's own testnet runs its v2 contracts, so this demo quotes on a test order book with the Kuru v1 interface used on mainnet. Every token here is a test token.",
        }
      : { name: "a local test book", note: "Local development chain with test tokens." };

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
