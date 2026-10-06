import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { chainById, getDeployment } from "@quoral/shared";

const env = (k: string, d?: string) => {
  const v = process.env[k];
  if (v === undefined || v === "") {
    if (d === undefined) throw new Error(`missing env ${k}`);
    return d;
  }
  return v;
};
const num = (k: string, d: number) => Number(env(k, String(d)));

export const chainId = num("CHAIN_ID", 31337);
export const chain = chainById(chainId);
export const rpcUrl = env("RPC_URL", chain.rpcUrls.default.http[0]);
// Monad: 300 ms blocks, so poll receipts fast so a requote never slips into the next epoch unseen.
export const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: chainId === 31337 ? 250 : 150 });

export function deployment() {
  return getDeployment(chainId);
}

export function agreementAddress(): Address {
  const a = process.env.AGREEMENT || deployment().agreement;
  if (!a) throw new Error("set AGREEMENT=<InventoryVault address>");
  return a as Address;
}

export const cfg = {
  signer: env("SIGNER", "local") as "local" | "privy",
  operatorKey: process.env.OPERATOR_KEY as `0x${string}` | undefined,
  privy: {
    appId: process.env.PRIVY_APP_ID ?? "",
    appSecret: process.env.PRIVY_APP_SECRET ?? "",
    walletId: process.env.PRIVY_WALLET_ID ?? "",
  },
  refPrice: env("REF_PRICE", "sim"),
  simStart: num("SIM_START_PRICE", 3900),
  as: {
    gamma: num("AS_GAMMA", 0.1),
    k: num("AS_K", 1.5),
    horizonS: num("AS_HORIZON_S", 60),
    minSpreadBps: num("MIN_SPREAD_BPS", 8),
    spreadSafety: num("SPREAD_SAFETY", 0.85),
    levels: num("LEVELS", 3),
    depthBuffer: num("DEPTH_BUFFER", 1.25),
  },
  keeperKey: process.env.KEEPER_KEY as `0x${string}` | undefined,
  keeperIntervalS: num("KEEPER_INTERVAL_S", 10),
};

export const log = (tag: string, ...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), `[${tag}]`, ...a);
