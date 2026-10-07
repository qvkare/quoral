/**
 * Demo step 4: what a compromised or malicious operator key can NOT do. Each attempt is simulated against
 * the live chain and must revert with the named error.
 *   1. withdraw inventory                         → NotIssuer
 *   2. give notice / rotate itself                → NotParty
 *   3. cross the book (post-only)                 → PostOnlyError (Kuru)
 *   4. quote wider than the SLA                   → SpreadTooWide
 *   5. pull the quotes right after the proof       → NotEnded (no cancel while live)
 *   6. walk the mid away from the market           → MidMovedTooFar (per-epoch drift cap)
 */
import { BaseError, ContractFunctionRevertedError, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { inventoryVaultAbi, heartbeatAbi, iKuruOrderBookAbi, parseBestBidAsk } from "@quoral/shared";
import { publicClient, agreementAddress, log, chain, chainId, rpcUrl, deployment } from "./config";
import { operatorSender } from "./signer";

const kuruErrors = [
  { type: "error", name: "PostOnlyError", inputs: [] },
  { type: "error", name: "MarketStateError", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
] as const;
const abi = [...inventoryVaultAbi, ...kuruErrors] as const;

async function attempt(label: string, account: Address, vault: Address, functionName: string, args: unknown[] = []) {
  try {
    await publicClient.simulateContract({ address: vault, abi, functionName: functionName as any, args: args as any, account });
    log("attack", `✗ ${label}: DID NOT REVERT`);
    return false;
  } catch (e) {
    const err = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
    const name = err?.data?.errorName ?? (e as BaseError).shortMessage;
    log("attack", `✓ ${label} → reverted: ${name}${err?.data?.args ? " " + JSON.stringify(err.data.args, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);
    return true;
  }
}

async function main() {
  const vault = agreementAddress();
  const op = (await operatorSender()).address;
  const terms = (await publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "terms" })) as any;
  const s = (await publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "marketScale" })) as any;
  const [b, a] = await publicClient.readContract({ address: terms.market, abi: iKuruOrderBookAbi, functionName: "bestBidAsk" });
  const { bid, ask } = parseBestBidAsk(b, a);
  const pp = Number(s.pricePrecision);
  const params = await publicClient.readContract({ address: terms.market, abi: iKuruOrderBookAbi, functionName: "getMarketParams" });
  const tickSize = Number(params[6]) || 1;
  /** float price → Kuru price units on the market's tick, so every attempt fails for its own reason */
  const px = (p: number) => Math.round((p * pp) / tickSize) * tickSize;
  const ref0 = (await publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "priceRef" })) as any;
  // measure from the vault's last proven mid when the book has nobody else on it
  const mid = bid && ask ? (bid + ask) / 2 : ref0.lastMid2 > 0n ? Number(ref0.lastMid2) / 2 / pp : 3900;
  const size = BigInt(Math.ceil((15_000 / mid) * Number(s.sizePrecision)));
  log("attack", `operator ${op} vs vault ${vault}; book ${bid?.toFixed(2)} / ${ask?.toFixed(2)}`);

  await attempt("operator withdraws inventory", op, vault, "withdrawInventory");
  await attempt("operator gives notice", op, vault, "giveNotice");
  await attempt("operator proposes itself a new operator", op, vault, "proposeOperator", [op]);
  // Post-only: the vault replaces its own quotes first, so the thing to cross must belong to someone else.
  // On mainnet the book has other makers; on the local mock we rest a third-party ask for the test.
  const third = chainId === 31337 ? await restThirdPartyAsk(terms.market, px(mid * 1.003), BigInt(s.sizePrecision) / 10n) : undefined;
  // Kuru's bestBidAsk includes our own quotes; crossing those proves nothing, because the vault cancels them first
  const hb = (await publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: "heartbeat" })) as Address;
  const last = ref0.lastMid2 > 0n
    ? ((await publicClient.readContract({ address: hb, abi: heartbeatAbi, functionName: "proofs", args: [BigInt(ref0.lastEpoch)] })) as readonly [number, number, ...unknown[]])
    : undefined;
  const ownAsk = ask !== undefined && last !== undefined && Math.round(ask * pp) === Number(last[1]);
  const otherAsk = third ? third.price / pp : ownAsk ? undefined : ask;
  if (!otherAsk) log("attack", "· post-only: no other maker rests on this book, so there is nothing to cross (the mainnet fork test shows Kuru rejecting a crossing quote)");
  if (otherAsk) {
    await attempt(`bid 5 bps through someone else's ask at ${otherAsk.toFixed(2)} (post-only)`, op, vault, "requote", [
      [px(otherAsk * 1.0005)], [size], [px(otherAsk * 1.004)], [size],
    ]);
  }
  if (third) await third.cancel();
  const wide = Number(terms.maxSpreadBps) * 2;
  await attempt(`quote ${wide} bps wide (SLA ${terms.maxSpreadBps})`, op, vault, "requote", [
    [px(mid * (1 - wide / 2e4))], [size], [px(mid * (1 + wide / 2e4))], [size],
  ]);
  await attempt("pull the quotes right after the proof", op, vault, "cancel");
  const ref = ref0;
  const cap = Number(terms.maxMidMoveBps);
  if (cap > 0 && ref.lastMid2 > 0n) {
    // twice the allowed move away from the last proven mid, quoted tight so only the drift cap can object
    const proven = Number(ref.lastMid2) / 2 / pp;
    const far = proven * (1 - (2 * cap * Math.max(1, ref.anchorGap)) / 1e4);
    await attempt(`walk the mid ${(2 * cap) / 100}% below the last proof (cap ${cap / 100}% per epoch)`, op, vault, "requote", [
      [px(far * 0.9995)], [size], [px(far * 1.0005)], [size],
    ]);
  }
}

/** Local demo only: anvil account #5 rests a small ask on the mock book, returning a cleanup function. */
async function restThirdPartyAsk(market: Address, price: number, size: bigint) {
  const d = deployment();
  if (!d.base || !d.marginAccount) return undefined;
  const account = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
  const w = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const abi = parseAbi([
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
    "function deposit(address,address,uint256) payable",
    "function addSellOrder(uint32,uint96,bool)",
    "function batchCancelOrders(uint40[])",
    "function s_orderIdCounter() view returns (uint40)",
  ]);
  const send = async (address: Address, functionName: string, args: unknown[]) =>
    publicClient.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi, functionName: functionName as never, args: args as never, chain }) });
  await send(d.base, "mint", [account.address, 10n ** 6n]);
  await send(d.base, "approve", [d.marginAccount, 10n ** 6n]);
  await send(d.marginAccount, "deposit", [account.address, d.base, 10n ** 6n]);
  await send(market, "addSellOrder", [price, size, false]);
  const id = (await publicClient.readContract({ address: market, abi, functionName: "s_orderIdCounter" })) as number;
  log("attack", `(local) a third party rests an ask at price units ${price}, order ${id}`);
  return { price, cancel: async () => void (await send(market, "batchCancelOrders", [[id]])) };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
