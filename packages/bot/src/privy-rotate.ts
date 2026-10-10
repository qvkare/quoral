/**
 * Makes the Privy server wallet the operator of the testnet agreement with the vault's 2-of-2 rotation: the
 * market maker proposes it, the issuer accepts. Reads the testnet keys from contracts/.env; safe to rerun.
 *
 *   PRIVY_ADDRESS=0x… pnpm --filter @quoral/bot privy:rotate
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { inventoryVaultAbi, monadTestnet } from "@quoral/shared";

const root = new URL("../../../contracts/", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(".env", root), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
) as Record<string, string>;
const dep = JSON.parse(readFileSync(new URL("deployments/10143.json", root), "utf8"));

const vault = (process.env.AGREEMENT || dep.agreement) as Address;
const target = process.env.PRIVY_ADDRESS as Address | undefined;
const transport = http(env.MONAD_TESTNET_RPC_URL);
const pc = createPublicClient({ chain: monadTestnet, transport });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function send(account: PrivateKeyAccount, functionName: "proposeOperator" | "acceptOperator", args: readonly [Address] | readonly []) {
  const wc = createWalletClient({ account, chain: monadTestnet, transport });
  const gas = await pc.estimateContractGas({ address: vault, abi: inventoryVaultAbi, functionName, args, account } as never);
  const hash = await wc.writeContract({ address: vault, abi: inventoryVaultAbi, functionName, args, gas: (gas * 115n) / 100n } as never);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  log(`${functionName} by ${account.address}: ${hash}`);
  return r.blockNumber;
}

async function main() {
  if (!target) throw new Error("set PRIVY_ADDRESS (printed by privy:setup)");
  const read = <T>(functionName: string) => pc.readContract({ address: vault, abi: inventoryVaultAbi, functionName } as never) as Promise<T>;
  const [operator, issuer, mm, pending] = await Promise.all([read<Address>("operator"), read<Address>("issuer"), read<Address>("mm"), read<Address>("pendingOperator")]);
  if (operator.toLowerCase() === target.toLowerCase()) return log(`already the operator: ${target}`);

  const keys = [env.TESTNET_OPS_KEY, env.TESTNET_MM_A_KEY, env.TESTNET_MM_B_KEY, env.TESTNET_MM_C_KEY].map((k) => privateKeyToAccount(k as Hex));
  const find = (a: Address) => keys.find((k) => k.address.toLowerCase() === a.toLowerCase());
  const mmKey = find(mm);
  const issuerKey = find(issuer);
  if (!mmKey || !issuerKey) throw new Error(`contracts/.env has no key for the issuer ${issuer} or the market maker ${mm}`);

  let after = 0n;
  if (pending.toLowerCase() !== target.toLowerCase()) after = await send(mmKey, "proposeOperator", [target]);
  // Monad reserve balance: a small account may send again only after 3 quiet blocks
  while ((await pc.getBlockNumber()) < after + 4n) await new Promise((r) => setTimeout(r, 400));
  await send(issuerKey, "acceptOperator", []);
  log(`operator ${operator} -> ${await read<Address>("operator")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
