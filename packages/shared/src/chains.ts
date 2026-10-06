import { defineChain } from "viem";
import { anvil } from "viem/chains";

/** Monad mainnet: 300 ms blocks, 600 ms finality (MIP-12). */
export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://monadvision.com" } },
});

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
  testnet: true,
});

export const chains = { 143: monad, 10143: monadTestnet, 31337: anvil } as const;

export function chainById(id: number) {
  const c = (chains as Record<number, (typeof chains)[keyof typeof chains]>)[id];
  if (!c) throw new Error(`unsupported chain ${id}`);
  return c;
}

/** Blocks per second for display maths (Monad: 300 ms; anvil demo: 1 s). */
export function blockTimeMs(chainId: number) {
  return chainId === 31337 ? 1000 : 300;
}
