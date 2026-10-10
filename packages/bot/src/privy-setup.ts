/**
 * Creates the Quoral operator policy and a policy-locked Privy server wallet for one agreement, then checks the
 * policy against Privy without sending anything: a requote to the vault must be signed, and a transfer elsewhere,
 * a call to another vault function and a personal_sign must be refused.
 *
 *   CHAIN_ID=10143 AGREEMENT=0x… PRIVY_APP_ID=… PRIVY_APP_SECRET=… pnpm --filter @quoral/bot privy:setup
 *
 * With PRIVY_WALLET_ID already set it only runs the checks. Next step: `privy:rotate` makes the wallet the operator.
 */
import { readFileSync } from "node:fs";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { PrivyError, privyHeaders, privyRpc, privySignTransaction, privyWalletAddress, type PrivyCreds } from "@quoral/shared/privy";
import { inventoryVaultAbi } from "@quoral/shared";
import { cfg, chainId, agreementAddress, publicClient } from "./config";

async function createWallet(vault: Address, heartbeat: Address): Promise<{ id: string; address: Address }> {
  const headers = privyHeaders(cfg.privy);
  const template = readFileSync(new URL("../privy-policy.json", import.meta.url), "utf8");
  const policy = JSON.parse(
    template.replaceAll("<VAULT>", vault.toLowerCase()).replaceAll("<HEARTBEAT>", heartbeat.toLowerCase()).replaceAll("<CHAIN_ID>", String(chainId)),
  );
  const p = await fetch("https://api.privy.io/v1/policies", { method: "POST", headers, body: JSON.stringify(policy) });
  const pj = await p.json();
  if (!p.ok) throw new Error(`policy: ${JSON.stringify(pj)}`);
  const w = await fetch("https://api.privy.io/v1/wallets", { method: "POST", headers, body: JSON.stringify({ chain_type: "ethereum", policy_ids: [pj.id] }) });
  const wj = await w.json();
  if (!w.ok) throw new Error(`wallet: ${JSON.stringify(wj)}`);
  console.log(`policy ${pj.id} (${policy.rules.length} rules)`);
  return { id: wj.id, address: wj.address };
}

async function expect(label: string, allowed: boolean, run: () => Promise<unknown>) {
  try {
    await run();
    console.log(`${allowed ? "ok  " : "FAIL"} ${label}: signed`);
    return allowed;
  } catch (e) {
    const refused = e instanceof PrivyError && e.status >= 400 && e.status < 500;
    console.log(`${!allowed && refused ? "ok  " : "FAIL"} ${label}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
    return !allowed && refused;
  }
}

async function main() {
  const { appId, appSecret } = cfg.privy;
  if (!appId || !appSecret) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET required");
  const vault = agreementAddress();
  const heartbeat = await publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "heartbeat" });

  let walletId = cfg.privy.walletId;
  if (!walletId) {
    const w = await createWallet(vault, heartbeat);
    walletId = w.id;
    console.log(`PRIVY_WALLET_ID=${w.id}\nPRIVY_ADDRESS=${w.address}`);
  }
  const creds: PrivyCreds = { appId, appSecret, walletId };
  const address = await privyWalletAddress(creds);

  // dry signatures only: nothing below is broadcast
  const base = { chainId, nonce: 0, gas: 600_000n, maxFeePerGas: 200_000_000_000n, maxPriorityFeePerGas: 0n };
  const requote = encodeFunctionData({ abi: inventoryVaultAbi, functionName: "requote", args: [[41_000_000], [3_000_000n], [41_100_000], [3_000_000n]] });
  const notice = encodeFunctionData({ abi: inventoryVaultAbi, functionName: "giveNotice" });
  const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [address, 1n] });
  const checks = await Promise.all([
    expect("requote on the vault", true, () => privySignTransaction(creds, { ...base, to: vault, data: requote })),
    expect("checkEpoch on the heartbeat", true, () =>
      privySignTransaction(creds, { ...base, to: heartbeat, data: encodeFunctionData({ abi: parseAbi(["function checkEpoch(uint256)"]), functionName: "checkEpoch", args: [0n] }) }),
    ),
    expect("requote on the same chain to another address", false, () => privySignTransaction(creds, { ...base, to: address, data: requote })),
    expect("requote on another chain", false, () => privySignTransaction(creds, { ...base, chainId: 1, to: vault, data: requote })),
    expect("giveNotice on the vault", false, () => privySignTransaction(creds, { ...base, to: vault, data: notice })),
    expect("token transfer", false, () => privySignTransaction(creds, { ...base, to: heartbeat, data: transfer as Hex })),
    expect("personal_sign", false, () => privyRpc(creds, "personal_sign", { message: "hello", encoding: "utf-8" })),
  ]);
  console.log(checks.every(Boolean) ? `\npolicy holds for ${address}` : "\npolicy check FAILED: do not rotate to this wallet");
  if (!checks.every(Boolean)) process.exit(1);
  console.log(`next: fund ${address} with MON, then pnpm --filter @quoral/bot privy:rotate`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
