export * from "./abis";
export * from "./chains";
export * from "./kuru";
import deploymentsJson from "./deployments.json";

export type Deployment = {
  chainId: number;
  startBlock: number;
  marginAccount: `0x${string}`;
  bondVault: `0x${string}`;
  registry: `0x${string}`;
  factory: `0x${string}`;
  rfq: `0x${string}`;
  rfqId?: number;
  keeperReceiver?: `0x${string}`;
  // local demo only
  market?: `0x${string}`;
  base?: `0x${string}`;
  quote?: `0x${string}`;
  agreement?: `0x${string}`;
  heartbeat?: `0x${string}`;
  paystream?: `0x${string}`;
};

export const deployments = deploymentsJson as unknown as Record<string, Deployment>;

export function getDeployment(chainId: number): Deployment {
  const d = deployments[String(chainId)];
  if (!d) throw new Error(`no Quoral deployment for chain ${chainId} (run forge script + pnpm abis)`);
  return d;
}

/** Mirrors contracts/src/libraries/Types.sol EpochStatus */
export enum EpochStatus {
  Pending = 0,
  Quoted = 1,
  Excused = 2,
  Missed = 3,
}

export type Terms = {
  market: `0x${string}`;
  baseInventory: bigint;
  quoteInventory: bigint;
  maxSpreadBps: number;
  minDepthQuote: bigint;
  epochBlocks: number;
  uptimeWindowEpochs: number;
  uptimeBps: number;
  retainerPerBlock: bigint;
  durationBlocks: bigint;
  noticeBlocks: bigint;
  bondAmount: bigint;
  slashAmount: bigint;
  pauseExcused: boolean;
  maxMidMoveBps: number;
  startDelayBlocks: number;
};
