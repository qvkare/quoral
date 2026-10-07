import {
  AgreementFactory,
  RFQAuction,
  DisclosureRegistry,
  BondVault,
  InventoryVault,
  Heartbeat,
  Paystream,
  KuruOrderBook,
  type Agreement,
  type Epoch,
  type handlerContext,
} from "generated";

const STATUS = ["PENDING", "QUOTED", "EXCUSED", "MISSED"] as const;
const lc = (a: string) => a.toLowerCase();

type Ev = { block: { number: number; timestamp: number }; transaction: { hash: string }; logIndex: number; chainId: number };

async function agreementOf(context: handlerContext, srcAddress: string): Promise<Agreement | undefined> {
  const link = await context.Link.get(lc(srcAddress));
  return link ? context.Agreement.get(link.agreement) : context.Agreement.get(lc(srcAddress));
}

function logEvent(context: handlerContext, event: Ev, agreement: string, kind: string, amount?: bigint, detail?: string) {
  context.AgreementEvent.set({
    id: `${event.chainId}-${event.block.number}-${event.logIndex}`,
    agreement_id: agreement,
    kind,
    amount,
    detail,
    block: BigInt(event.block.number),
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
}

async function epochEntity(context: handlerContext, agreement: string, epoch: bigint): Promise<Epoch> {
  const id = `${agreement}-${epoch}`;
  return (
    (await context.Epoch.get(id)) ?? {
      id,
      agreement_id: agreement,
      epoch,
      status: "PENDING",
      quotes: 0,
      bestBid: undefined,
      bestAsk: undefined,
      spreadBps: undefined,
      bidDepth: undefined,
      askDepth: undefined,
      lastBlock: undefined,
    }
  );
}

// ------------------------------------------------------------------ factory

AgreementFactory.AgreementCreated.contractRegister(({ event, context }) => {
  context.addInventoryVault(event.params.agreement);
  context.addHeartbeat(event.params.heartbeat);
  context.addPaystream(event.params.paystream);
});

AgreementFactory.AgreementCreated.handler(async ({ event, context }) => {
  const p = event.params;
  const id = lc(p.agreement);
  context.Agreement.set({
    id,
    chainId: event.chainId,
    issuer: lc(p.issuer),
    mm: lc(p.mm),
    operator: lc(p.operator),
    heartbeat: lc(p.heartbeat),
    paystream: lc(p.paystream),
    market: lc(p.market),
    baseToken: lc(p.baseToken),
    quoteToken: lc(p.quoteToken),
    termsHash: p.termsHash,
    uri: undefined,
    startBlock: p.startBlock,
    endBlock: p.endBlock,
    retainerPerBlock: 0n,
    bond: 0n,
    quotedEpochs: 0,
    excusedEpochs: 0,
    missedEpochs: 0,
    settledEpochs: 0n,
    requotes: 0,
    lastSpreadBps: undefined,
    lastBidDepth: undefined,
    lastAskDepth: undefined,
    lastBestBid: undefined,
    lastBestAsk: undefined,
    lastQuoteBlock: undefined,
    clawedBack: 0n,
    claimedNet: 0n,
    fees: 0n,
    refunded: 0n,
    slashed: 0n,
    breaches: 0,
    noticeGiven: false,
    finalized: false,
    fills: 0,
    filledBase: 0n,
  });
  context.Link.set({ id: lc(p.heartbeat), agreement: id });
  context.Link.set({ id: lc(p.paystream), agreement: id });
  logEvent(context, event, id, "CREATED", undefined, p.termsHash);
});

// ------------------------------------------------------------------ RFQ

RFQAuction.RFQOpened.handler(async ({ event, context }) => {
  context.RFQ.set({
    id: `${event.chainId}-${event.params.id}`,
    issuer: lc(event.params.issuer),
    market: lc(event.params.market),
    deadline: event.params.deadline,
    uri: event.params.uri,
    status: "OPEN",
    winner: undefined,
    agreement: undefined,
    winningRetainer: undefined,
  });
});

RFQAuction.BidPlaced.handler(async ({ event, context }) => {
  const rfq = `${event.chainId}-${event.params.id}`;
  context.Bid.set({
    id: `${rfq}-${lc(event.params.bidder)}`,
    rfq_id: rfq,
    bidder: lc(event.params.bidder),
    retainerPerBlock: event.params.retainerPerBlock,
    operator: lc(event.params.operator),
    active: true,
  });
});

RFQAuction.BidWithdrawn.handler(async ({ event, context }) => {
  const id = `${event.chainId}-${event.params.id}-${lc(event.params.bidder)}`;
  const b = await context.Bid.get(id);
  if (b) context.Bid.set({ ...b, active: false });
});

RFQAuction.Awarded.handler(async ({ event, context }) => {
  const id = `${event.chainId}-${event.params.id}`;
  const r = await context.RFQ.get(id);
  if (r) {
    context.RFQ.set({
      ...r,
      status: "AWARDED",
      winner: lc(event.params.winner),
      agreement: lc(event.params.agreement),
      winningRetainer: event.params.retainerPerBlock,
    });
  }
  const bid = await context.Bid.get(`${id}-${lc(event.params.winner)}`);
  if (bid) context.Bid.set({ ...bid, active: false });
  const a = await context.Agreement.get(lc(event.params.agreement));
  if (a) context.Agreement.set({ ...a, retainerPerBlock: event.params.retainerPerBlock });
});

RFQAuction.RFQCancelled.handler(async ({ event, context }) => {
  const r = await context.RFQ.get(`${event.chainId}-${event.params.id}`);
  if (r) context.RFQ.set({ ...r, status: "CANCELLED" });
});

// ------------------------------------------------------------------ disclosure & bonds

DisclosureRegistry.Disclosed.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.params.agreement));
  if (a) context.Agreement.set({ ...a, uri: event.params.uri });
});

DisclosureRegistry.URIUpdated.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.params.agreement));
  if (a) context.Agreement.set({ ...a, uri: event.params.uri });
});

BondVault.Assigned.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.params.agreement));
  if (a) context.Agreement.set({ ...a, bond: a.bond + event.params.amount });
});

BondVault.Slashed.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.params.agreement));
  if (!a) return;
  context.Agreement.set({ ...a, slashed: a.slashed + event.params.amount, bond: a.bond - event.params.amount });
  logEvent(context, event, a.id, "SLASH", event.params.amount, lc(event.params.to));
});

BondVault.Released.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.params.agreement));
  if (a) logEvent(context, event, a.id, "BOND_RELEASED", event.params.amount);
});

// ------------------------------------------------------------------ vault

InventoryVault.Requoted.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.srcAddress));
  if (!a) return;
  const [bestBid, bestAsk, spreadBps, , bidDepth, askDepth] = event.params.proof;
  context.Agreement.set({
    ...a,
    requotes: a.requotes + 1,
    lastSpreadBps: Number(spreadBps),
    lastBidDepth: bidDepth,
    lastAskDepth: askDepth,
    lastBestBid: bestBid,
    lastBestAsk: bestAsk,
    lastQuoteBlock: BigInt(event.block.number),
  });
  // every proof is a public transaction: keep it in the agreement's log with its hash
  logEvent(context, event, a.id, "QUOTE", undefined, `epoch ${event.params.epoch}: ${bestBid} / ${bestAsk}, ${spreadBps} bps`);
});

InventoryVault.InventoryLimited.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.srcAddress));
  if (!a) return;
  const side = event.params.askShort ? "base" : "quote";
  logEvent(context, event, a.id, "INVENTORY_LIMITED", undefined, `epoch ${event.params.epoch}: ${side} used up, all of it posted`);
});

InventoryVault.InventoryAdded.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.srcAddress));
  if (a) logEvent(context, event, a.id, "INVENTORY_ADDED", event.params.quoteAmount, `base ${event.params.baseAmount}`);
});

InventoryVault.NoticeGiven.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.srcAddress));
  if (!a) return;
  context.Agreement.set({ ...a, noticeGiven: true, endBlock: event.params.newEndBlock });
  logEvent(context, event, a.id, "NOTICE", undefined, `${lc(event.params.by)} → end ${event.params.newEndBlock}`);
});

InventoryVault.OperatorChanged.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.srcAddress));
  if (!a) return;
  context.Agreement.set({ ...a, operator: lc(event.params.newOperator) });
  logEvent(context, event, a.id, "OPERATOR", undefined, lc(event.params.newOperator));
});

InventoryVault.InventoryWithdrawn.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.srcAddress));
  if (a) logEvent(context, event, a.id, "WITHDRAW", event.params.quoteAmount, `base ${event.params.baseAmount}`);
});

InventoryVault.Finalized.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.srcAddress));
  if (!a) return;
  context.Agreement.set({ ...a, finalized: true });
  logEvent(context, event, a.id, "FINALIZED");
});

// ------------------------------------------------------------------ heartbeat

Heartbeat.HeartbeatRecorded.handler(async ({ event, context }) => {
  const a = await agreementOf(context, event.srcAddress);
  if (!a) return;
  const [bestBid, bestAsk, spreadBps, , bidDepth, askDepth] = event.params.proof;
  const e = await epochEntity(context, a.id, event.params.epoch);
  context.Epoch.set({
    ...e,
    status: e.status === "PENDING" ? "QUOTED" : e.status,
    quotes: e.quotes + 1,
    bestBid,
    bestAsk,
    spreadBps: Number(spreadBps),
    bidDepth,
    askDepth,
    lastBlock: BigInt(event.block.number),
  });
});

Heartbeat.EpochExcused.handler(async ({ event, context }) => {
  const a = await agreementOf(context, event.srcAddress);
  if (!a) return;
  const e = await epochEntity(context, a.id, event.params.epoch);
  if (e.status === "PENDING") context.Epoch.set({ ...e, status: "EXCUSED" });
  logEvent(context, event, a.id, "EXCUSED", undefined, `epoch ${event.params.epoch}`);
});

Heartbeat.EpochSettled.handler(async ({ event, context }) => {
  const a = await agreementOf(context, event.srcAddress);
  if (!a) return;
  const status = STATUS[Number(event.params.status)] ?? "PENDING";
  const e = await epochEntity(context, a.id, event.params.epoch);
  context.Epoch.set({ ...e, status });
  context.Agreement.set({
    ...a,
    settledEpochs: event.params.epoch + 1n,
    quotedEpochs: a.quotedEpochs + (status === "QUOTED" ? 1 : 0),
    excusedEpochs: a.excusedEpochs + (status === "EXCUSED" ? 1 : 0),
    missedEpochs: a.missedEpochs + (status === "MISSED" ? 1 : 0),
  });
});

Heartbeat.UptimeBreached.handler(async ({ event, context }) => {
  const a = await agreementOf(context, event.srcAddress);
  if (!a) return;
  context.Agreement.set({ ...a, breaches: a.breaches + 1 });
  logEvent(
    context,
    event,
    a.id,
    "BREACH",
    event.params.slashed,
    `window ${event.params.window}: ${event.params.misses} misses > ${event.params.allowedMisses} allowed`,
  );
});

// ------------------------------------------------------------------ paystream

Paystream.Clawback.handler(async ({ event, context }) => {
  const a = await agreementOf(context, event.srcAddress);
  if (!a) return;
  context.Agreement.set({ ...a, clawedBack: a.clawedBack + event.params.amount });
  logEvent(context, event, a.id, "CLAWBACK", event.params.amount, `${event.params.missedEpochs} epoch(s)`);
});

Paystream.Claimed.handler(async ({ event, context }) => {
  const a = await agreementOf(context, event.srcAddress);
  if (!a) return;
  context.Agreement.set({ ...a, claimedNet: a.claimedNet + event.params.net, fees: a.fees + event.params.fee });
  logEvent(context, event, a.id, "CLAIM", event.params.net, `fee ${event.params.fee}`);
});

Paystream.Refunded.handler(async ({ event, context }) => {
  const a = await agreementOf(context, event.srcAddress);
  if (!a) return;
  context.Agreement.set({ ...a, refunded: a.refunded + event.params.amount });
  logEvent(context, event, a.id, "REFUND", event.params.amount);
});

// ------------------------------------------------------------------ Kuru fills on vault orders

KuruOrderBook.Trade.handler(async ({ event, context }) => {
  const a = await context.Agreement.get(lc(event.params.makerAddress));
  if (!a) return;
  context.Agreement.set({ ...a, fills: a.fills + 1, filledBase: a.filledBase + event.params.filledSize });
  logEvent(
    context,
    event,
    a.id,
    "FILL",
    event.params.filledSize,
    `${event.params.isBuy ? "bid" : "ask"} #${event.params.orderId} @ ${event.params.price}`,
  );
});
