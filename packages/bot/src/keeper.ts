/**
 * Fallback epoch keeper (Chainlink CRE cron is primary, see /cre). For every agreement from the factory:
 *   - venue paused & pauseExcused  → heartbeat.flagPause()
 *   - ended epochs unsettled       → heartbeat.checkEpoch(latestEnded)   (clawback + slash happen here)
 *   - ended & fully settled        → vault.finalize()
 * All three calls are permissionless; the keeper key only pays gas.
 */
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agreementFactoryAbi, inventoryVaultAbi, heartbeatAbi } from "@quoral/shared";
import { publicClient, chain, rpcUrl, cfg, deployment, log } from "./config";

const MAX_BATCH = 500n; // epochs settled per tx

async function main() {
  if (!cfg.keeperKey) throw new Error("KEEPER_KEY required");
  const account = privateKeyToAccount(cfg.keeperKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const factory = deployment().factory;
  log("keeper", `factory ${factory} keeper ${account.address} every ${cfg.keeperIntervalS}s`);

  const write = async (address: Address, abi: any, functionName: string, args: any[] = []) => {
    const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account });
    const hash = await wallet.writeContract(request as any);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, gas: r.gasUsed, ok: r.status === "success" };
  };

  async function service(vault: Address) {
    const rv = (fn: string) => publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: fn as any }) as Promise<any>;
    const [finalized, live, heartbeat, total, endBlock, current, terms] = await Promise.all([
      rv("finalized"), rv("isLive"), rv("heartbeat"), rv("totalEpochs"), rv("endBlock"), rv("currentEpoch"), rv("terms"),
    ]);
    if (finalized) return;
    const hb = heartbeat as Address;
    const settled = (await publicClient.readContract({ address: hb, abi: heartbeatAbi, functionName: "settledEpochs" })) as bigint;
    const block = await publicClient.getBlockNumber();
    const ended = block >= endBlock;

    if (live && terms.pauseExcused && (await rv("venuePaused"))) {
      const status = (await publicClient.readContract({ address: hb, abi: heartbeatAbi, functionName: "status", args: [current] })) as number;
      if (status === 0) {
        const r = await write(hb, heartbeatAbi, "flagPause");
        log("keeper", `${vault.slice(0, 8)} venue paused → epoch ${current} excused (${r.hash.slice(0, 10)})`);
      }
    }

    const lastEnded = ended ? total - 1n : current - 1n;
    if (lastEnded >= settled) {
      const target = lastEnded - settled + 1n > MAX_BATCH ? settled + MAX_BATCH - 1n : lastEnded;
      const r = await write(hb, heartbeatAbi, "checkEpoch", [target]);
      const missed = await publicClient.readContract({ address: hb, abi: heartbeatAbi, functionName: "missedCount" });
      log("keeper", `${vault.slice(0, 8)} settled epochs ${settled}..${target} (total missed ${missed}) gas ${r.gas}`);
      return;
    }
    if (ended && settled >= total) {
      const r = await write(vault, inventoryVaultAbi, "finalize");
      log("keeper", `${vault.slice(0, 8)} finalized (${r.hash.slice(0, 10)})`);
    }
  }

  const loop = async () => {
    try {
      const n = (await publicClient.readContract({ address: factory, abi: agreementFactoryAbi, functionName: "agreementCount" })) as bigint;
      for (let i = 0n; i < n; i++) {
        const a = (await publicClient.readContract({ address: factory, abi: agreementFactoryAbi, functionName: "agreements", args: [i] })) as Address;
        await service(a).catch((e) => log("keeper", `${a.slice(0, 8)} error: ${e.shortMessage ?? e.message}`));
      }
    } catch (e) {
      log("keeper", "loop error", (e as Error).message);
    }
  };
  await loop();
  setInterval(loop, cfg.keeperIntervalS * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
