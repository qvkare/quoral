import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { privySignTransaction, privyWalletAddress } from "@quoral/shared/privy";
import { cfg, chain, chainId, publicClient, rpcUrl } from "./config";

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
 * Privy server wallet (app-owned). The wallet carries the policy in privy-policy.json: it may only sign zero-value
 * transactions on this chain to this agreement's vault (requote, cancel, finalize) and heartbeat (checkEpoch,
 * flagPause); every other method (sign message / typed data / raw sign) is denied by default. Privy signs and we
 * broadcast, so the gas limit and fees stay ours (Monad bills the whole limit).
 */
export async function privySender(): Promise<Sender> {
  const { appId, appSecret, walletId } = cfg.privy;
  if (!appId || !appSecret || !walletId) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_WALLET_ID required");
  const creds = { appId, appSecret, walletId };
  const address = await privyWalletAddress(creds);
  return {
    address,
    async send(to, data, gas) {
      const [estimate, fees, nonce] = await Promise.all([
        gas ? Promise.resolve(gas) : publicClient.estimateGas({ account: address, to, data }).then((g) => (g * 115n) / 100n),
        publicClient.estimateFeesPerGas(),
        publicClient.getTransactionCount({ address, blockTag: "pending" }),
      ]);
      const raw = await privySignTransaction(creds, {
        to,
        data,
        chainId,
        nonce,
        gas: estimate,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      return publicClient.sendRawTransaction({ serializedTransaction: raw });
    },
  };
}

export async function operatorSender(): Promise<Sender> {
  if (cfg.signer === "privy") return privySender();
  if (!cfg.operatorKey) throw new Error("OPERATOR_KEY required for SIGNER=local");
  return localSender(cfg.operatorKey);
}
