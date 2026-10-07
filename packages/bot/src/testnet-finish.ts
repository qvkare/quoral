/**
 * Finishes the Monad testnet demo after `forge script DeployTestnet` deployed the contracts: funds the bidders,
 * opens the RFQ, places three bonded bids and awards the lowest. Idempotent: it reads chain state and only does
 * what is missing, so it can be rerun safely.
 *
 * Why not forge: Monad keeps a 10 MON reserve balance per account with a 3-block window. An account below 10 MON
 * may only send a transaction that dips under the reserve when it sent nothing in the previous 3 blocks, so a
 * burst of sends from a small testnet wallet reverts. This script waits 4 blocks between sends from one account.
 *
 *   pnpm --filter @quoral/bot testnet:finish      (reads contracts/.env and contracts/deployments/10143.json)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, maxUint256, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { rfqAuctionAbi, bondVaultAbi, mockERC20Abi, inventoryVaultAbi, monadTestnet } from "@quoral/shared";

const root = new URL("../../../contracts/", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(".env", root), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
) as Record<string, string>;
const depPath = new URL("deployments/10143.json", root);
const dep = JSON.parse(readFileSync(depPath, "utf8"));

const transport = http(env.MONAD_TESTNET_RPC_URL);
const pc = createPublicClient({ chain: monadTestnet, transport });
const ops = privateKeyToAccount(env.TESTNET_OPS_KEY as Hex);
const mms = [env.TESTNET_MM_A_KEY, env.TESTNET_MM_B_KEY, env.TESTNET_MM_C_KEY].map((k) => privateKeyToAccount(k as Hex));
const operator = env.TESTNET_OPERATOR_ADDRESS as Address;
const BIDS = [12_000n, 9_500n, 11_000n]; // retainer per block, raw USDC units
const EPOCH_BLOCKS = 600;
const DURATION_EPOCHS = 14_400n;

const lastSend = new Map<Address, bigint>();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function waitBlocks(from: Address) {
  const last = lastSend.get(from);
  if (last === undefined) return;
  while ((await pc.getBlockNumber()) < last + 4n) await new Promise((r) => setTimeout(r, 400));
}

/** Send one tx from `who`, honouring the reserve-balance window, and require success. */
async function send(who: PrivateKeyAccount, label: string, req: Record<string, unknown>) {
  await waitBlocks(who.address);
  const wc = createWalletClient({ account: who, chain: monadTestnet, transport });
  let hash: Hex;
  if ("abi" in req) {
    const gas = await pc.estimateContractGas({ ...req, account: who.address } as never);
    hash = await wc.writeContract({ ...req, gas: (gas * 120n) / 100n } as never);
  } else {
    hash = await wc.sendTransaction({ ...req, gas: 100_000n } as never); // value to a new account: estimate is too low
  }
  const r = await pc.waitForTransactionReceipt({ hash });
  lastSend.set(who.address, r.blockNumber);
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  log("ok", label, hash.slice(0, 12));
}

const usdc = { address: dep.quote as Address, abi: mockERC20Abi } as const;
const bonds = { address: dep.bondVault as Address, abi: bondVaultAbi } as const;
const rfq = { address: dep.rfq as Address, abi: rfqAuctionAbi } as const;

async function main() {
  log("ops", ops.address, (Number(await pc.getBalance({ address: ops.address })) / 1e18).toFixed(3), "MON");

  // 1. gas money for the bidders
  for (const m of mms) {
    if ((await pc.getBalance({ address: m.address })) < parseEther("0.05")) {
      await send(ops, `fund ${m.address.slice(0, 8)}`, { to: m.address, value: parseEther("0.06") });
    }
  }
  // 2. test USDC for bonds
  for (const m of mms) {
    const bal = await pc.readContract({ ...usdc, functionName: "balanceOf", args: [m.address] });
    const inVault = (await pc.readContract({ ...bonds, functionName: "free", args: [m.address] })) +
      (await pc.readContract({ ...bonds, functionName: "locked", args: [m.address] }));
    if (bal < 20_000_000_000n && inVault === 0n) {
      await send(ops, `mint USDC to ${m.address.slice(0, 8)}`, { ...usdc, functionName: "mint", args: [m.address, 100_000_000_000n] });
    }
  }
  // 3. the RFQ (same terms as DeployTestnet.s.sol)
  if ((await pc.readContract({ ...rfq, functionName: "rfqCount" })) === 0n) {
    const terms = {
      market: dep.market as Address,
      baseInventory: 10_000_000n,
      quoteInventory: 50_000_000_000n,
      maxSpreadBps: 50,
      minDepthQuote: 10_000_000_000n,
      epochBlocks: EPOCH_BLOCKS,
      uptimeWindowEpochs: 20,
      uptimeBps: 9000,
      retainerPerBlock: 20_000n,
      durationBlocks: BigInt(EPOCH_BLOCKS) * DURATION_EPOCHS,
      noticeBlocks: 2_000n,
      bondAmount: 10_000_000_000n,
      slashAmount: 500_000_000n,
      pauseExcused: true,
    };
    await send(ops, "openRFQ", { ...rfq, functionName: "openRFQ", args: [terms, 2_000n, "ipfs://quoral-testnet/xaut0-usdc.json"] });
  }
  const id = await pc.readContract({ ...rfq, functionName: "rfqCount" });
  // 4. bonded bids
  for (const [i, m] of mms.entries()) {
    const [, , active] = await pc.readContract({ ...rfq, functionName: "bids", args: [id, m.address] });
    if (active) continue;
    const allowance = await pc.readContract({ ...usdc, functionName: "allowance", args: [m.address, bonds.address] });
    if (allowance < 20_000_000_000n) await send(m, `approve bond ${i}`, { ...usdc, functionName: "approve", args: [bonds.address, maxUint256] });
    if ((await pc.readContract({ ...bonds, functionName: "free", args: [m.address] })) < 10_000_000_000n) {
      await send(m, `deposit bond ${i}`, { ...bonds, functionName: "deposit", args: [20_000_000_000n] });
    }
    await send(m, `bid ${i}`, { ...rfq, functionName: "bid", args: [id, BIDS[i], operator] });
  }
  // 5. award the lowest bid
  const r = await pc.readContract({ ...rfq, functionName: "rfq", args: [id] });
  if (r.status === 1) {
    const [best] = await pc.readContract({ ...rfq, functionName: "bestBid", args: [id] });
    await send(ops, `award ${best.slice(0, 8)}`, { ...rfq, functionName: "award", args: [id, best] });
  }
  // 6. record the live addresses
  const done = await pc.readContract({ ...rfq, functionName: "rfq", args: [id] });
  const agreement = done.agreement;
  const v = { address: agreement, abi: inventoryVaultAbi } as const;
  dep.agreement = agreement;
  dep.heartbeat = await pc.readContract({ ...v, functionName: "heartbeat" });
  dep.paystream = await pc.readContract({ ...v, functionName: "paystream" });
  writeFileSync(depPath, JSON.stringify(dep, null, 2) + "\n");
  log("agreement", agreement, "winner", done.winner, "| ops left", (Number(await pc.getBalance({ address: ops.address })) / 1e18).toFixed(3), "MON");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ") : e);
  process.exit(1);
});
