/**
 * Quoral epoch keeper on Chainlink CRE.
 *
 * Cron (≥30 s, CRE minimum) → read every agreement from AgreementFactory via the EVM capability →
 * build jobs (checkEpoch for ended-but-unsettled epochs, flagPause while the venue is paused) →
 * DON-signed report → Keystone forwarder → CREKeeperReceiver.onReport → Heartbeat.
 *
 * The receiver holds no privilege (all heartbeat calls are permissionless); CRE gives decentralized liveness,
 * and packages/bot/src/keeper.ts is the self-hosted fallback.
 */
import {
  cre,
  Runner,
  getNetwork,
  encodeCallMsg,
  bytesToHex,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  type Runtime,
  type CronPayload,
} from "@chainlink/cre-sdk";
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, parseAbi, zeroAddress, type Address, type Hex } from "viem";

type Config = {
  schedule: string;
  chainSelectorName: string;
  isTestnet: boolean;
  receiver: Address;
  factory: Address;
  gasLimit: string;
  maxAgreements: number;
};

const factoryAbi = parseAbi([
  "function agreementCount() view returns (uint256)",
  "function agreements(uint256) view returns (address)",
]);
const vaultAbi = parseAbi([
  "function heartbeat() view returns (address)",
  "function finalized() view returns (bool)",
  "function isLive() view returns (bool)",
  "function currentEpoch() view returns (uint256)",
  "function totalEpochs() view returns (uint256)",
  "function endBlock() view returns (uint64)",
  "function venuePaused() view returns (bool)",
]);
const heartbeatAbi = parseAbi([
  "function settledEpochs() view returns (uint256)",
  "function pauseExcused() view returns (bool)",
  "function status(uint256) view returns (uint8)",
]);

const JOB_TUPLE = [
  {
    type: "tuple[]",
    components: [
      { name: "heartbeat", type: "address" },
      { name: "kind", type: "uint8" },
      { name: "epoch", type: "uint256" },
    ],
  },
] as const;

const onCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const cfg = runtime.config;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: cfg.isTestnet });
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);

  const read = <T>(to: Address, abi: any, functionName: string, args: unknown[] = []): T => {
    const data = encodeFunctionData({ abi, functionName, args } as any);
    const res = evm
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to, data }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
    return decodeFunctionResult({ abi, functionName, data: bytesToHex(res.data) as Hex } as any) as T;
  };

  const n = Number(read<bigint>(cfg.factory, factoryAbi, "agreementCount"));
  const jobs: { heartbeat: Address; kind: number; epoch: bigint }[] = [];
  for (let i = Math.max(0, n - cfg.maxAgreements); i < n; i++) {
    const vault = read<Address>(cfg.factory, factoryAbi, "agreements", [BigInt(i)]);
    if (read<boolean>(vault, vaultAbi, "finalized")) continue;
    const hb = read<Address>(vault, vaultAbi, "heartbeat");
    const current = read<bigint>(vault, vaultAbi, "currentEpoch");
    const total = read<bigint>(vault, vaultAbi, "totalEpochs");
    const live = read<boolean>(vault, vaultAbi, "isLive");
    const settled = read<bigint>(hb, heartbeatAbi, "settledEpochs");

    const lastEnded = live ? current - 1n : total - 1n;
    if (lastEnded >= settled) jobs.push({ heartbeat: hb, kind: 0, epoch: lastEnded });

    if (live && read<boolean>(hb, heartbeatAbi, "pauseExcused") && read<boolean>(vault, vaultAbi, "venuePaused")) {
      if (read<number>(hb, heartbeatAbi, "status", [current]) === 0) jobs.push({ heartbeat: hb, kind: 1, epoch: current });
    }
  }

  if (jobs.length === 0) {
    runtime.log(`quoral-keeper: ${n} agreements, nothing to settle`);
    return "noop";
  }

  const payload = encodeAbiParameters(JOB_TUPLE, [jobs]);
  const report = runtime
    .report({ encodedPayload: hexToBase64(payload), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result();
  const resp = evm
    .writeReport(runtime, { receiver: cfg.receiver, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();
  const tx = resp.txHash ? bytesToHex(resp.txHash) : "pending";
  runtime.log(`quoral-keeper: ${jobs.length} job(s) → ${tx}`);
  return tx;
};

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
