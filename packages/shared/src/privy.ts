/**
 * Privy server wallet as the Quoral operator: Privy signs, we broadcast.
 *
 * The wallet is app-owned and carries the policy in packages/bot/privy-policy.json: it may only sign zero-value
 * transactions on one chain to one agreement's vault (requote, cancel, finalize) and heartbeat (checkEpoch,
 * flagPause). Privy rejects everything else before signing, including messages and typed data.
 *
 * We use eth_signTransaction rather than eth_sendTransaction so that Privy never has to know the chain: the caller
 * fixes nonce, gas limit and fees (Monad bills the whole gas limit, so this matters) and broadcasts the raw
 * transaction through its own RPC. Plain fetch, so it runs in Node and in Cloudflare Workers alike.
 */
import type { Address, Hex } from "viem";

export type PrivyCreds = { appId: string; appSecret: string; walletId: string };

export type PrivyTx = {
  to: Address;
  data: Hex;
  chainId: number;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

const API = "https://api.privy.io/v1";

export function privyHeaders(c: Pick<PrivyCreds, "appId" | "appSecret">) {
  return {
    "content-type": "application/json",
    "privy-app-id": c.appId,
    authorization: "Basic " + btoa(`${c.appId}:${c.appSecret}`),
  };
}

export class PrivyError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`privy ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

export async function privyWalletAddress(c: PrivyCreds): Promise<Address> {
  const res = await fetch(`${API}/wallets/${c.walletId}`, { headers: privyHeaders(c) });
  const j = (await res.json()) as { address?: string };
  if (!res.ok || !j.address) throw new PrivyError(res.status, j);
  return j.address as Address;
}

/** Any wallet RPC call; throws PrivyError when Privy (or its policy) refuses. */
export async function privyRpc(c: PrivyCreds, method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/wallets/${c.walletId}/rpc`, {
    method: "POST",
    headers: privyHeaders(c),
    body: JSON.stringify({ method, params }),
  });
  const j = (await res.json()) as { data?: Record<string, unknown> };
  if (!res.ok || !j.data) throw new PrivyError(res.status, j);
  return j.data;
}

/** Signs an EIP-1559 transaction with value 0 and returns the raw RLP, ready for eth_sendRawTransaction. */
export async function privySignTransaction(c: PrivyCreds, tx: PrivyTx): Promise<Hex> {
  const data = await privyRpc(c, "eth_signTransaction", {
    transaction: {
      type: 2,
      chain_id: tx.chainId,
      nonce: tx.nonce,
      to: tx.to,
      data: tx.data,
      value: "0x0",
      gas_limit: "0x" + tx.gas.toString(16),
      max_fee_per_gas: "0x" + tx.maxFeePerGas.toString(16),
      max_priority_fee_per_gas: "0x" + tx.maxPriorityFeePerGas.toString(16),
    },
  });
  const raw = data.signed_transaction;
  if (typeof raw !== "string") throw new PrivyError(200, data);
  return raw as Hex;
}
