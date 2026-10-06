/**
 * Quoral house quoter: every epoch, compute an Avellaneda–Stoikov ladder constrained by the agreement's SLA
 * and call `vault.requote(...)`. The vault cancels its own previous quotes, places the new ones post-only,
 * proves the SLA and records the heartbeat, all in one transaction.
 *
 *   pnpm bot            (reads packages/bot/.env, see .env.example)
 */
import { decodeEventLog, encodeFunctionData, formatUnits, BaseError, ContractFunctionRevertedError, type Address, type Hex } from "viem";
import { inventoryVaultAbi, heartbeatAbi, iKuruOrderBookAbi, fromPrice, fromSize, notional, parseBestBidAsk, type MarketScale } from "@quoral/shared";
import { publicClient, agreementAddress, cfg, log, chainId } from "./config";

const chainIdPoll = chainId === 31337 ? 500 : 200;
import { operatorSender } from "./signer";
import { asQuote, inventoryImbalance, VolEstimator } from "./as-model";

type OpenOrder = { price: bigint; size: bigint; isBuy: boolean };

// ------------------------------------------------------------------ reference price

function priceSource(market: Address, scale: MarketScale, own: () => Map<number, OpenOrder>) {
  const [kind, ...rest] = cfg.refPrice.split(":");
  const arg = rest.join(":");
  let px = cfg.simStart;
  let lastT = Date.now();
  return async (): Promise<number> => {
    if (kind === "static") return Number(arg);
    if (kind === "sim") {
      // GBM, σ ≈ 2 bps/√s
      const now = Date.now();
      const dt = (now - lastT) / 1000;
      lastT = now;
      const z = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
      px *= Math.exp(0.0002 * Math.sqrt(dt) * z);
      return px;
    }
    if (kind === "http") {
      const [url, path = ""] = arg.split("#");
      const j = await fetch(url).then((r) => r.json());
      return Number(path.split(".").filter(Boolean).reduce((o: any, k) => o?.[k], j));
    }
    // "book": Kuru mid, ignoring levels that are our own resting quotes
    const [b, a] = await publicClient.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "bestBidAsk" });
    const { bid, ask } = parseBestBidAsk(b, a);
    const ours = new Set([...own().values()].map((o) => Number(o.price) / Number(scale.pricePrecision)));
    const ob = bid && !ours.has(bid) ? bid : undefined;
    const oa = ask && !ours.has(ask) ? ask : undefined;
    if (ob && oa) px = (ob + oa) / 2;
    else if (ob || oa) px = (ob ?? oa)!;
    return px;
  };
}

// ------------------------------------------------------------------ main

async function main() {
  const vault = agreementAddress();
  const sender = await operatorSender();
  const read = <F extends string>(functionName: F, args: readonly unknown[] = []) =>
    publicClient.readContract({ address: vault, abi: inventoryVaultAbi, functionName: functionName as any, args: args as any }) as Promise<any>;

  const terms = await read("terms");
  const s = await read("marketScale");
  const market = terms.market as Address;
  const [, , , , , , tickSize, minSize, maxSize] = await publicClient.readContract({
    address: market,
    abi: iKuruOrderBookAbi,
    functionName: "getMarketParams",
  });
  const scale: MarketScale = {
    pricePrecision: s.pricePrecision,
    sizePrecision: s.sizePrecision,
    baseDecimals: s.baseDecimals,
    quoteDecimals: s.quoteDecimals,
    tickSize: BigInt(tickSize),
    minSize: BigInt(minSize),
    maxSize: BigInt(maxSize),
  };
  const operator = (await read("operator")) as Address;
  if (operator.toLowerCase() !== sender.address.toLowerCase()) {
    throw new Error(`signer ${sender.address} is not the vault operator ${operator}`);
  }
  const qd = Number(scale.quoteDecimals);
  const bd = Number(scale.baseDecimals);
  const sla = { maxSpreadBps: Number(terms.maxSpreadBps), minDepthQuote: Number(formatUnits(terms.minDepthQuote, qd)) };
  log("quoter", `vault ${vault} market ${market} operator ${operator}`);
  log("quoter", `SLA spread ≤ ${sla.maxSpreadBps} bps, depth ≥ ${sla.minDepthQuote} per side, epoch ${terms.epochBlocks} blocks`);

  const open = new Map<number, OpenOrder>();
  const ref = priceSource(market, scale, () => open);
  const vol = new VolEstimator();
  const heartbeat = (await read("heartbeat")) as Address;
  let lastAttempt = { epoch: -1n, block: 0n };
  let lastScanBlock = await publicClient.getBlockNumber();
  let busy = false;

  async function dropFilled(toBlock: bigint) {
    if (open.size === 0 || toBlock <= lastScanBlock) return;
    const logs = await publicClient.getContractEvents({
      address: market,
      abi: iKuruOrderBookAbi,
      eventName: "Trade",
      fromBlock: lastScanBlock + 1n,
      toBlock,
    });
    for (const l of logs) {
      const a = l.args as any;
      if (a.makerAddress?.toLowerCase() === vault.toLowerCase() && a.updatedSize === 0n) open.delete(Number(a.orderId));
    }
    lastScanBlock = toBlock;
  }

  async function requote(epoch: bigint, block: bigint) {
    await dropFilled(block);
    const mid = await ref();
    vol.update(mid, Date.now());

    const [freeBase, freeQuote] = (await read("marginBalances")) as [bigint, bigint];
    // inventory locked in our own resting orders is released by the cancel in the same tx
    let availBase = freeBase;
    let availQuote = freeQuote;
    for (const o of open.values()) {
      if (o.isBuy) availQuote += notional(o.price, o.size, scale);
      else availBase += (o.size * 10n ** scale.baseDecimals) / scale.sizePrecision;
    }
    const q = inventoryImbalance(Number(formatUnits(availBase, bd)), Number(formatUnits(availQuote, qd)), mid);
    const ladder = asQuote(mid, vol.sigma, q, sla, cfg.as);

    const clampSize = (x: number) => {
      let v = fromSize(x, scale);
      if (v < scale.minSize) v = scale.minSize;
      if (v > scale.maxSize) v = scale.maxSize;
      return v;
    };
    const bidPrices = ladder.bids.map((l) => fromPrice(l.price, scale, "bid"));
    const askPrices = ladder.asks.map((l) => fromPrice(l.price, scale, "ask"));
    // round sizes up so each level keeps ≥ its share of the depth target after integer truncation
    const bidSizes = ladder.bids.map((l) => clampSize(l.size) + 1n);
    const askSizes = ladder.asks.map((l) => clampSize(l.size) + 1n);

    const needQuote = bidPrices.reduce((acc, p, i) => acc + notional(p, bidSizes[i], scale), 0n);
    const needBase = askSizes.reduce((acc, z) => acc + (z * 10n ** scale.baseDecimals) / scale.sizePrecision, 0n);
    if (needQuote > availQuote || needBase > availBase) {
      log("quoter", `⚠ inventory exhausted (need ${formatUnits(needBase, bd)} base / ${formatUnits(needQuote, qd)} quote), skipping epoch ${epoch}; the issuer must top up or rebalance`);
      return;
    }

    const args = [bidPrices.map(Number), bidSizes, askPrices.map(Number), askSizes] as const;
    try {
      // Monad charges gas_limit, not gas used: simulate, then send with a tight explicit limit.
      await publicClient.simulateContract({ address: vault, abi: inventoryVaultAbi, functionName: "requote", args, account: sender.address });
      const est = await publicClient.estimateContractGas({ address: vault, abi: inventoryVaultAbi, functionName: "requote", args, account: sender.address });
      const data = encodeFunctionData({ abi: inventoryVaultAbi, functionName: "requote", args });
      const hash = await sender.send(vault, data as Hex, (est * 115n) / 100n);
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error(`requote reverted: ${hash}`);

      open.clear();
      let proof: any;
      for (const l of rcpt.logs) {
        try {
          if (l.address.toLowerCase() === market.toLowerCase()) {
            const ev = decodeEventLog({ abi: iKuruOrderBookAbi, data: l.data, topics: l.topics });
            if (ev.eventName === "OrderCreated" && (ev.args as any).owner.toLowerCase() === vault.toLowerCase()) {
              const a = ev.args as any;
              open.set(Number(a.orderId), { price: BigInt(a.price), size: a.size, isBuy: a.isBuy });
            }
          } else if (l.address.toLowerCase() === vault.toLowerCase()) {
            const ev = decodeEventLog({ abi: inventoryVaultAbi, data: l.data, topics: l.topics });
            if (ev.eventName === "Requoted") {
              proof = (ev.args as any).proof;
              epoch = (ev.args as any).epoch;
            }
          }
        } catch {}
      }
      lastScanBlock = rcpt.blockNumber;
      log(
        "quoter",
        `epoch ${epoch} ✓ mid ${mid.toFixed(2)} σ ${(vol.sigma * 1e4).toFixed(2)}bps/√s q ${q.toFixed(2)} → ` +
          `spread ${proof?.spreadBps}bps depth ${formatUnits(proof?.bidDepthQuote ?? 0n, qd)}/${formatUnits(proof?.askDepthQuote ?? 0n, qd)} ` +
          `orders ${open.size} gas ${rcpt.gasUsed} tx ${hash.slice(0, 10)}`,
      );
    } catch (e) {
      const reason =
        e instanceof BaseError
          ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)?.data?.errorName ??
            e.shortMessage
          : String(e);
      log("quoter", `✗ epoch ${epoch} requote failed: ${reason}`);
    }
  }

  /** After a restart, learn which of the vault's orders are resting from its latest requote receipt. */
  async function adoptOpenOrders() {
    const latest = await publicClient.getBlockNumber();
    const logs = await publicClient.getContractEvents({
      address: vault,
      abi: inventoryVaultAbi,
      eventName: "Requoted",
      fromBlock: latest > 5_000n ? latest - 5_000n : 0n,
      toBlock: latest,
    });
    const last = logs[logs.length - 1];
    if (!last) return;
    const rcpt = await publicClient.getTransactionReceipt({ hash: last.transactionHash! });
    for (const l of rcpt.logs) {
      if (l.address.toLowerCase() !== market.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: iKuruOrderBookAbi, data: l.data, topics: l.topics });
        const a = ev.args as any;
        if (ev.eventName === "OrderCreated" && a.owner.toLowerCase() === vault.toLowerCase()) {
          open.set(Number(a.orderId), { price: BigInt(a.price), size: a.size, isBuy: a.isBuy });
        }
      } catch {}
    }
    lastScanBlock = rcpt.blockNumber;
    if (open.size) log("quoter", `adopted ${open.size} resting vault orders from block ${rcpt.blockNumber}`);
  }
  await adoptOpenOrders();

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const block = await publicClient.getBlockNumber();
      if (!(await read("isLive"))) {
        log("quoter", "agreement not live, exiting");
        process.exit(0);
      }
      // Quote whenever the current epoch has no proof yet (covers epoch rollover and retries failures),
      // throttled to one attempt per block.
      const epoch = (await read("currentEpoch")) as bigint;
      const status = await publicClient.readContract({ address: heartbeat, abi: heartbeatAbi, functionName: "status", args: [epoch] });
      if (status !== 1 && !(lastAttempt.epoch === epoch && lastAttempt.block === block)) {
        lastAttempt = { epoch, block };
        await requote(epoch, block);
      }
    } catch (e) {
      log("quoter", "tick error", (e as Error).message);
    } finally {
      busy = false;
    }
  };
  await tick();
  setInterval(tick, chainIdPoll);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
