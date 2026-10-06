"use client";

import { erc20Abi, type Account, type Address, type WalletClient } from "viem";
import { inventoryVaultAbi, heartbeatAbi } from "@quoral/shared";
import { chain, publicClient } from "./chain";

type W = { client: WalletClient; account: Account | Address };

/** writeContract with the session's chain/account filled in. */
export function write(w: W, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) {
  return w.client.writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: w.account, chain } as never);
}

export async function ensureAllowance(w: W, tokenAddr: Address, owner: Address, spender: Address, amount: bigint) {
  if (amount === 0n) return;
  const cur = await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (cur >= amount) return;
  const h = await write(w, tokenAddr, erc20Abi, "approve", [spender, amount]);
  await publicClient.waitForTransactionReceipt({ hash: h });
}

/** Settles every ended epoch (permissionless). */
export async function settleAll(w: W, vault: Address) {
  const [heartbeat, current, total, live] = await Promise.all([
    publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "heartbeat" }),
    publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "currentEpoch" }),
    publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "totalEpochs" }),
    publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "isLive" }),
  ]);
  const settled = await publicClient.readContract({ address: heartbeat, abi: heartbeatAbi, functionName: "settledEpochs" });
  const target = live ? current - 1n : total - 1n;
  if (target < settled || target < 0n) throw new Error("Nothing to settle yet. The current epoch has not ended.");
  return write(w, heartbeat, heartbeatAbi, "checkEpoch", [target]);
}

export const DAY_MS = 86_400_000;
