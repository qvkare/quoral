"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { parseUnits, erc20Abi, type Address } from "viem";
import { rfqAuctionAbi, inventoryVaultAbi, iKuruOrderBookAbi } from "@quoral/shared";
import { useWallet } from "@/lib/wallet";
import { usePoll } from "@/lib/hooks";
import { dep, fmt, short, blocksToDuration, BLOCK_MS, isAddress, publicClient } from "@/lib/chain";
import { listAgreements, listRFQs, loadAgreement, token, type TokenInfo } from "@/lib/agreement";
import { write, ensureAllowance, settleAll, DAY_MS } from "@/lib/actions";
import { TxButton, PageHead, StatusPill } from "@/components/ui";

const LOCAL = BLOCK_MS >= 1000;
const DEFAULTS = {
  baseInventory: "10",
  quoteInventory: "50000",
  maxSpreadBps: "50",
  minDepth: "10000",
  epochBlocks: LOCAL ? "10" : "100",
  windowEpochs: LOCAL ? "20" : "2880",
  uptimePct: "95",
  retainerPerDay: "1500",
  durationDays: "30",
  noticeBlocks: LOCAL ? "200" : "28800",
  bond: "5000",
  slash: "1000",
  biddingBlocks: LOCAL ? "600" : "2000",
  uri: "ipfs://",
};
type Form = typeof DEFAULTS;
const RFQ_STATUS = ["", "Open", "Awarded", "Cancelled"];
const ZERO = "0x0000000000000000000000000000000000000000";

function validate(f: Form) {
  const e: Partial<Record<keyof Form, string>> = {};
  const n = (k: keyof Form) => Number(f[k]);
  if (!(n("maxSpreadBps") > 0 && n("maxSpreadBps") < 10_000)) e.maxSpreadBps = "1 – 9,999 bps";
  if (!(n("minDepth") > 0)) e.minDepth = "Must be positive";
  if (!(n("uptimePct") > 0 && n("uptimePct") <= 100)) e.uptimePct = "0 – 100%";
  if (!(Number.isInteger(n("epochBlocks")) && n("epochBlocks") > 0)) e.epochBlocks = "Whole number of blocks";
  if (!(Number.isInteger(n("windowEpochs")) && n("windowEpochs") > 0)) e.windowEpochs = "Whole number of epochs";
  if (!(n("durationDays") > 0)) e.durationDays = "Must be positive";
  if (!(n("retainerPerDay") > 0)) e.retainerPerDay = "Must be positive";
  if (!(n("baseInventory") >= 0) || !(n("quoteInventory") >= 0) || n("baseInventory") + n("quoteInventory") === 0) e.baseInventory = "Lock some inventory";
  if (!(n("slash") <= n("bond"))) e.slash = "Can't exceed the bond";
  if (!(Number.isInteger(n("noticeBlocks")) && n("noticeBlocks") >= 0)) e.noticeBlocks = "Whole number of blocks";
  if (!(Number.isInteger(n("biddingBlocks")) && n("biddingBlocks") > 0)) e.biddingBlocks = "Whole number of blocks";
  return e;
}

function Field({ label, hint, unit, value, onChange, error }: { label: string; hint?: string; unit?: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <label className="f">
      {label}
      <span className={unit ? "suffix" : ""}>
        <input inputMode="decimal" value={value} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
        {unit && <span>{unit}</span>}
      </span>
      {error ? <small style={{ color: "var(--bad)" }}>{error}</small> : hint && <small>{hint}</small>}
    </label>
  );
}

export default function IssuerConsole() {
  const w = useWallet();
  const d = dep();
  const [market, setMarket] = useState<string>(d.market ?? "");
  const [f, setF] = useState<Form>(DEFAULTS);
  const set = (k: keyof Form) => (v: string) => setF({ ...f, [k]: v });
  const errors = validate(f);
  const valid = Object.keys(errors).length === 0 && isAddress(market);

  const { data: mkt } = usePoll(
    async () => {
      if (!isAddress(market)) return null;
      const p = await publicClient.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "getMarketParams" });
      const [b, q] = await Promise.all([token(p[2]), token(p[4])]);
      return { b, q };
    },
    30_000,
    [market],
  );
  const { data: rfqs, refresh: refreshRfqs } = usePoll(listRFQs, 4000);
  const { data: mine, refresh: refreshMine } = usePoll(
    async () => {
      if (!w.address) return [];
      const all = await Promise.all((await listAgreements()).map((a) => loadAgreement(a, 2)));
      return all.filter((a) => a.issuer.toLowerCase() === w.address!.toLowerCase());
    },
    4000,
    [w.address],
  );

  const blocksPerDay = Math.round(DAY_MS / BLOCK_MS);
  const summary = useMemo(() => {
    const epochBlocks = Number(f.epochBlocks) || 1;
    const durationBlocks = Math.ceil(((Number(f.durationDays) || 0) * blocksPerDay) / epochBlocks) * epochBlocks;
    const allowed = Math.floor(((Number(f.windowEpochs) || 0) * (100 - (Number(f.uptimePct) || 0))) / 100);
    const budget = (Number(f.retainerPerDay) || 0) * (durationBlocks / blocksPerDay);
    return { epochBlocks, durationBlocks, allowed, budget };
  }, [f, blocksPerDay]);

  async function openRFQ() {
    if (!w.client || !w.account || !w.address) throw new Error("Sign in first");
    if (!isAddress(market)) throw new Error("Enter a Kuru OrderBook address");
    if (!valid) throw new Error("Fix the highlighted fields first");
    const p = await publicClient.readContract({ address: market, abi: iKuruOrderBookAbi, functionName: "getMarketParams" });
    const [base, quote] = await Promise.all([token(p[2]), token(p[4])]);
    const retainerPerBlock = parseUnits(f.retainerPerDay, quote.decimals) / BigInt(blocksPerDay);
    const durationBlocks = BigInt(summary.durationBlocks);
    const terms = {
      market,
      baseInventory: parseUnits(f.baseInventory, base.decimals),
      quoteInventory: parseUnits(f.quoteInventory, quote.decimals),
      maxSpreadBps: Number(f.maxSpreadBps),
      minDepthQuote: parseUnits(f.minDepth, quote.decimals),
      epochBlocks: summary.epochBlocks,
      uptimeWindowEpochs: Number(f.windowEpochs),
      uptimeBps: Math.round(Number(f.uptimePct) * 100),
      retainerPerBlock,
      durationBlocks,
      noticeBlocks: BigInt(f.noticeBlocks),
      bondAmount: parseUnits(f.bond, quote.decimals),
      slashAmount: parseUnits(f.slash, quote.decimals),
      pauseExcused: true,
    };
    // the factory pulls inventory + the retainer budget (≤ cap) at award time
    const w2 = { client: w.client, account: w.account };
    await ensureAllowance(w2, base.address, w.address, d.factory, terms.baseInventory);
    await ensureAllowance(w2, quote.address, w.address, d.factory, terms.quoteInventory + retainerPerBlock * durationBlocks);
    return w.send((c, account) => write({ client: c, account }, d.rfq, rfqAuctionAbi, "openRFQ", [terms, BigInt(f.biddingBlocks), f.uri]));
  }

  const myRfqs = (rfqs ?? []).filter((r) => w.address && r.issuer.toLowerCase() === w.address.toLowerCase()).reverse();
  const B = mkt?.b.symbol ?? "BASE";
  const Q = mkt?.q.symbol ?? "QUOTE";

  return (
    <main>
      <div className="wrap stack" style={{ gap: 28 }}>
        <PageHead
          crumb="Issuers"
          title="Write the terms, then let market makers bid"
          sub="Write the service level, lock inventory and a retainer budget, and let bonded market makers bid for the seat. The terms page goes live the moment you award."
        />
        {!w.address && (
          <div className="notice">Sign in with a passkey or wallet (top right) to open RFQs and manage agreements. You can explore the form without signing in.</div>
        )}

        <div className="split">
          <div className="card pad-lg stack" style={{ gap: 26 }}>
            <fieldset className="stack">
              <legend>Market</legend>
              <label className="f">
                Kuru OrderBook address
                <input className="mono" value={market} onChange={(e) => setMarket(e.target.value)} placeholder="0x… (e.g. XAUt0-USDC)" aria-invalid={market !== "" && !isAddress(market)} />
                <small>{mkt ? <>This is the <b>{mkt.b.symbol} / {mkt.q.symbol}</b> market. Retainer, bond and depth are in {mkt.q.symbol}.</> : "Paste a Kuru market; must be enabled on Quoral."}</small>
              </label>
            </fieldset>

            <fieldset className="stack">
              <legend>Service level</legend>
              <div className="grid g3">
                <Field label="Max spread" unit="bps" value={f.maxSpreadBps} onChange={set("maxSpreadBps")} error={errors.maxSpreadBps} hint={`${(Number(f.maxSpreadBps) / 100 || 0).toFixed(2)}% of mid`} />
                <Field label="Min depth per side" unit={Q} value={f.minDepth} onChange={set("minDepth")} error={errors.minDepth} hint="within ±max spread of mid" />
                <Field label="Uptime target" unit="%" value={f.uptimePct} onChange={set("uptimePct")} error={errors.uptimePct} hint={`${summary.allowed} missed epochs allowed per window`} />
                <Field label="Epoch length" unit="blocks" value={f.epochBlocks} onChange={set("epochBlocks")} error={errors.epochBlocks} hint={`≈ ${blocksToDuration(Number(f.epochBlocks) || 0)} per proof`} />
                <Field label="Uptime window" unit="epochs" value={f.windowEpochs} onChange={set("windowEpochs")} error={errors.windowEpochs} hint={`≈ ${blocksToDuration((Number(f.windowEpochs) || 0) * (Number(f.epochBlocks) || 0))}`} />
                <Field label="Duration" unit="days" value={f.durationDays} onChange={set("durationDays")} error={errors.durationDays} />
              </div>
            </fieldset>

            <fieldset className="stack">
              <legend>Inventory &amp; economics</legend>
              <div className="grid g3">
                <Field label="Base inventory" unit={B} value={f.baseInventory} onChange={set("baseInventory")} error={errors.baseInventory} hint="locked in the quote-only vault" />
                <Field label="Quote inventory" unit={Q} value={f.quoteInventory} onChange={set("quoteInventory")} />
                <Field label="Retainer cap" unit={`${Q}/day`} value={f.retainerPerDay} onChange={set("retainerPerDay")} error={errors.retainerPerDay} hint="bids above this are rejected" />
                <Field label="MM bond" unit={Q} value={f.bond} onChange={set("bond")} hint="locked by each bidder" />
                <Field label="Penalty per breach" unit={Q} value={f.slash} onChange={set("slash")} error={errors.slash} hint="slashed to you per failed window" />
                <Field label="Notice period" unit="blocks" value={f.noticeBlocks} onChange={set("noticeBlocks")} error={errors.noticeBlocks} hint={`≈ ${blocksToDuration(Number(f.noticeBlocks) || 0)}`} />
              </div>
            </fieldset>

            <fieldset className="stack">
              <legend>RFQ</legend>
              <div className="grid g2">
                <Field label="Bidding window" unit="blocks" value={f.biddingBlocks} onChange={set("biddingBlocks")} error={errors.biddingBlocks} hint={`≈ ${blocksToDuration(Number(f.biddingBlocks) || 0)}`} />
                <label className="f">
                  Public terms document
                  <input value={f.uri} onChange={(e) => set("uri")(e.target.value)} placeholder="ipfs://…" />
                  <small>Linked from the public page; its hash is fixed onchain.</small>
                </label>
              </div>
            </fieldset>
          </div>

          <aside className="card pad-lg stack sticky" aria-label="Summary">
            <h3>Summary</h3>
            <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
              <dt>You lock</dt>
              <dd style={{ textAlign: "right" }}><b>{Number(f.baseInventory || 0).toLocaleString("en-US")} {B}</b><br /><b>{Number(f.quoteInventory || 0).toLocaleString("en-US")} {Q}</b></dd>
              <dt>Max retainer budget</dt>
              <dd style={{ textAlign: "right" }}><b>{summary.budget.toLocaleString("en-US", { maximumFractionDigits: 0 })} {Q}</b></dd>
              <dt>Proofs per day</dt>
              <dd style={{ textAlign: "right" }}>{Math.round(blocksPerDay / summary.epochBlocks).toLocaleString("en-US")}</dd>
              <dt>Missed epoch refund</dt>
              <dd style={{ textAlign: "right" }}>automatic</dd>
            </dl>
            <div className="notice small">
              <span>Nothing leaves your wallet until you <b>award</b> a bid. Unused retainer is refunded at the end; inventory returns only to you.</span>
            </div>
            <TxButton className="primary lg" label={w.address ? "Approve & open RFQ" : "Sign in to continue"} run={openRFQ} disabled={!w.address || !valid} onDone={refreshRfqs} pendingLabel="Approve in wallet…" />
            <p className="tiny muted" style={{ margin: 0 }}>Excluded by design: volume or price targets, token loans, call options.</p>
          </aside>
        </div>

        <section className="card pad-lg stack" id="rfqs">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Your RFQs</h2>
            <span className="muted small">{myRfqs.length} total</span>
          </div>
          {myRfqs.length === 0 && <p className="muted" style={{ margin: 0 }}>{w.address ? "You haven't opened an RFQ yet." : "Sign in to see your RFQs."}</p>}
          {myRfqs.map((r) => <RFQRow key={r.id.toString()} r={r} onDone={() => { refreshRfqs(); refreshMine(); }} />)}
        </section>

        <section className="card pad-lg stack">
          <h2 style={{ margin: 0 }}>Your agreements</h2>
          {!mine?.length && <p className="muted" style={{ margin: 0 }}>{w.address ? "No agreements yet. Award a bid to create one." : "Sign in to manage your agreements."}</p>}
          {mine?.map((a) => (
            <div key={a.vault} className="card flat">
              <div className="row between">
                <div>
                  <Link href={`/${a.vault}`} style={{ textDecoration: "none" }}><b>{a.base.symbol} / {a.quote.symbol}</b></Link>{" "}
                  <span className="muted mono tiny">{short(a.vault)}</span>
                  <div className="muted small">
                    Market maker <span className="mono">{short(a.mm)}</span>, bar {a.epoch.current.toString()} of {a.epoch.total.toString()}.{" "}
                    {fmt(a.pay.clawedBack, a.quote.decimals, 2)} {a.quote.symbol} refunded to you so far.
                  </div>
                </div>
                <StatusPill a={a} />
              </div>
              <div className="row" style={{ marginTop: 14, alignItems: "flex-start" }}>
                <TxButton label="Settle ended epochs" onDone={refreshMine} run={() => w.send((c, account) => settleAll({ client: c, account }, a.vault))} />
                {a.live && !a.noticeGiven && (
                  <TxButton label="Give notice" className="danger" onDone={refreshMine} run={() => w.send((c, account) => write({ client: c, account }, a.vault, inventoryVaultAbi, "giveNotice"))} />
                )}
                {a.pendingOperator !== ZERO && (
                  <TxButton label={`Accept operator ${short(a.pendingOperator)}`} onDone={refreshMine} run={() => w.send((c, account) => write({ client: c, account }, a.vault, inventoryVaultAbi, "acceptOperator"))} />
                )}
                {!a.live && (
                  <>
                    <TxButton label="Cancel resting quotes" onDone={refreshMine}
                      run={() => w.send((c, account) => write({ client: c, account }, a.vault, inventoryVaultAbi, "cancel"))} />
                    {!a.finalized && <TxButton label="Finalize" onDone={refreshMine} run={() => w.send((c, account) => write({ client: c, account }, a.vault, inventoryVaultAbi, "finalize"))} />}
                    <TxButton label="Withdraw inventory" className="primary" onDone={refreshMine} run={() => w.send((c, account) => write({ client: c, account }, a.vault, inventoryVaultAbi, "withdrawInventory"))} />
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
        <WalletBalances />
      </div>
    </main>
  );
}

type R = Awaited<ReturnType<typeof listRFQs>>[number];

function RFQRow({ r, onDone }: { r: R; onDone: () => void }) {
  const w = useWallet();
  const d = dep();
  const perDay = BigInt(Math.round(DAY_MS / BLOCK_MS));
  const { data: q } = usePoll<TokenInfo>(async () => {
    const p = await publicClient.readContract({ address: r.terms.market, abi: iKuruOrderBookAbi, functionName: "getMarketParams" });
    return token(p[4]);
  }, 60_000, [r.id]);
  const sorted = [...r.bids].sort((a, b) => Number(a.retainerPerBlock - b.retainerPerBlock));
  const lowest = sorted.find((b) => b.active);
  const day = (v: bigint) => (q ? `${fmt(v * perDay, q.decimals, 0)} ${q.symbol}/day` : "…");
  return (
    <div className="card flat">
      <div className="row between">
        <div>
          <b>RFQ {r.id.toString()}</b> <span className="muted mono tiny">{short(r.terms.market)}</span>
          <div className="muted small">
            Spread at most {r.terms.maxSpreadBps} bps, {r.terms.uptimeBps / 100}% uptime, retainer cap {day(r.terms.retainerPerBlock)}. Bids close at block{" "}
            {r.deadline.toString()}.{r.agreement !== ZERO && <> <Link href={`/${r.agreement}`}>Open the agreement</Link>.</>}
          </div>
        </div>
        <span className="pill">{RFQ_STATUS[r.status]}</span>
      </div>
      <div className="tbl-wrap" style={{ marginTop: 10 }}>
        <table className="cards">
          <thead>
            <tr><th>Bidder</th><th className="num">Retainer</th><th>Operator key</th><th className="num">Action</th></tr>
          </thead>
          <tbody>
            {sorted.map((b) => (
              <tr key={b.bidder}>
                <td className="head mono">{short(b.bidder)} {lowest?.bidder === b.bidder && r.status === 1 && <span className="marking" style={{ marginLeft: 6 }}>lowest</span>}</td>
                <td data-label="Retainer" className="num"><b>{day(b.retainerPerBlock)}</b></td>
                <td data-label="Operator key" className="mono">{short(b.operator)}</td>
                <td data-label="Action" className="num">
                  {r.status === 1 && b.active ? (
                    <TxButton label="Award" className="primary" onDone={onDone} pendingLabel="Deploying…"
                      run={() => w.send((c, account) => write({ client: c, account }, d.rfq, rfqAuctionAbi, "award", [r.id, b.bidder]))} />
                  ) : (
                    <span className="muted small">{r.winner === b.bidder ? "Winner" : b.active ? "Waiting" : "Withdrawn"}</span>
                  )}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={4} className="muted">No bids yet. Market makers see this RFQ in their console.</td></tr>}
          </tbody>
        </table>
      </div>
      {r.status === 1 && (
        <div style={{ marginTop: 10 }}>
          <TxButton label="Cancel RFQ" className="danger" onDone={onDone}
            run={() => w.send((c, account) => write({ client: c, account }, d.rfq, rfqAuctionAbi, "cancelRFQ", [r.id]))} />
        </div>
      )}
    </div>
  );
}

function WalletBalances() {
  const w = useWallet();
  const d = dep();
  const { data } = usePoll(
    async () => {
      if (!w.address || !d.base || !d.quote) return undefined;
      const [b, q] = await Promise.all([token(d.base), token(d.quote)]);
      const [bb, qb] = await Promise.all([
        publicClient.readContract({ address: b.address, abi: erc20Abi, functionName: "balanceOf", args: [w.address as Address] }),
        publicClient.readContract({ address: q.address, abi: erc20Abi, functionName: "balanceOf", args: [w.address as Address] }),
      ]);
      return `${fmt(bb, b.decimals, 4)} ${b.symbol} and ${fmt(qb, q.decimals)} ${q.symbol}`;
    },
    5000,
    [w.address],
  );
  if (!data) return null;
  return <p className="muted small" style={{ margin: 0 }}>Wallet balance: {data}</p>;
}
