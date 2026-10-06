import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cfg, chain, chainId, rpcUrl } from "./config";

/** Minimal tx sender so the quoter is agnostic to where the operator key lives. */
export interface Sender {
  address: Address;
  send(to: Address, data: Hex, gas?: bigint): Promise<Hex>;
}

export function localSender(pk: Hex): Sender {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  return {
    address: account.address,
    send: (to, data, gas) => wallet.sendTransaction({ to, data, gas, chain }),
  };
}

/**
 * Privy server wallet (app-owned). The wallet is created with the policy in privy-policy.json, which only
 * allows `eth_sendTransaction` to the agreement vault with value 0 on this chain; every other RPC method
 * (sign message / typed data / raw sign) is denied by default. Onchain, the vault already restricts the
 * operator to `requote` + `cancel`, so the key can neither move inventory nor send MON anywhere.
 */
export async function privySender(): Promise<Sender> {
  const { appId, appSecret, walletId } = cfg.privy;
  if (!appId || !appSecret || !walletId) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_WALLET_ID required");
  const headers = {
    "content-type": "application/json",
    "privy-app-id": appId,
    authorization: "Basic " + Buffer.from(`${appId}:${appSecret}`).toString("base64"),
  };
  const w = await fetch(`https://api.privy.io/v1/wallets/${walletId}`, { headers }).then((r) => r.json());
  if (!w.address) throw new Error(`privy wallet lookup failed: ${JSON.stringify(w)}`);
  return {
    address: w.address as Address,
    async send(to, data, gas) {
      const body = {
        method: "eth_sendTransaction",
        caip2: `eip155:${chainId}`,
        params: { transaction: { to, data, value: "0x0", ...(gas ? { gas_limit: `0x${gas.toString(16)}` } : {}) } },
      };
      const res = await fetch(`https://api.privy.io/v1/wallets/${walletId}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok || !j?.data?.hash) throw new Error(`privy rpc ${res.status}: ${JSON.stringify(j)}`);
      return j.data.hash as Hex;
    },
  };
}

export async function operatorSender(): Promise<Sender> {
  if (cfg.signer === "privy") return privySender();
  if (!cfg.operatorKey) throw new Error("OPERATOR_KEY required for SIGNER=local");
  return localSender(cfg.operatorKey);
}
