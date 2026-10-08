"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { usePoll } from "@/lib/hooks";
import { listAgreements, loadAgreement, type AgreementView } from "@/lib/agreement";
import { fmt, short, blocksToDuration, BLOCK_MS, VENUE } from "@/lib/chain";
import { Score, type ScoreHandle } from "./Score";
import { Rehearsal, DEFAULT_TERMS, type SimTerms } from "./Rehearsal";
import { Skeleton } from "./ui";

/** One poll for the whole landing page: the most recent agreement, with its last 64 bars. */
const Ctx = createContext<AgreementView | null | undefined>(undefined);

export function LatestProvider({ children }: { children: ReactNode }) {
  const { data } = usePoll(async () => {
    const list = await listAgreements();
    if (!list.length) return null;
    return loadAgreement(list[list.length - 1], 64, 64);
  }, 1500);
  return <Ctx.Provider value={data}>{children}</Ctx.Provider>;
}

const useLatest = () => useContext(Ctx);

function useProgress(a: AgreementView | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  if (!a) return 0;
  return Math.min(1, a.progress + (now - a.fetchedAt) / (a.terms.epochBlocks * BLOCK_MS));
}

/** The rehearsal console, on the live agreement's terms once they are read. */
export function LiveRehearsal() {
  const a = useLatest();
  const vault = a?.vault;
  const terms = useMemo((): SimTerms => {
    if (!a) return DEFAULT_TERMS;
    const n = (v: bigint) => Number(formatUnits(v, a.quote.decimals));
    return {
      symbol: a.quote.symbol,
      maxSpreadBps: Number(a.terms.maxSpreadBps),
      minDepth: n(a.terms.minDepthQuote),
      perBar: n(a.pay.retainerPerBlock * BigInt(a.terms.epochBlocks)),
      windowBars: Number(a.epoch.windowEpochs),
      allowedMisses: Number(a.epoch.allowedMisses),
      slash: n(a.terms.slashAmount),
      bond: n(a.terms.bondAmount),
      barLength: blocksToDuration(a.terms.epochBlocks),
    };
    // the terms of an agreement never change, so read them once per agreement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);
  return <Rehearsal terms={terms} />;
}

export function LiveScore() {
  const a = useLatest();
  const progress = useProgress(a);
  const score = useRef<ScoreHandle>(null);
  const [playing, setPlaying] = useState(false);

  if (a === undefined) {
    return (
      <div aria-busy="true">
        <div className="score-head"><Skeleton h={16} w={220} /></div>
        <Skeleton h={190} />
      </div>
    );
  }
  if (a === null) {
    return (
      <div>
        <div className="score-head"><b>No agreement is live yet</b></div>
        <p className="caption">The score starts when the first RFQ is awarded.</p>
      </div>
    );
  }
  const qd = a.quote.decimals;
  const perBar = a.pay.retainerPerBlock * BigInt(a.terms.epochBlocks);
  const settledBars = a.counts.quoted + a.counts.excused + a.counts.missed;
  const pct = settledBars > 0n ? (Number(a.counts.quoted + a.counts.excused) / Number(settledBars)) * 100 : 100;
  return (
    <div>
      <div className="score-head">
        <span>
          <b>{a.base.symbol} / {a.quote.symbol}</b> <span className="muted">on {VENUE.name}, agreement</span>{" "}
          <Link href={`/${a.vault}`} className="mono">{short(a.vault)}</Link>
        </span>
        <span className="row" style={{ gap: 22 }}>
          <span>Bar {a.epoch.current.toLocaleString("en-US")}</span>
          <span>{pct.toFixed(1)}% of settled bars quoted</span>
          <span style={{ color: a.pay.clawedBack > 0n ? "var(--pencil)" : undefined }}>
            {fmt(a.pay.clawedBack + a.bond.totalSlashed, qd)} {a.quote.symbol} returned to the issuer
          </span>
          <button
            type="button"
            className="linkbtn"
            aria-pressed={playing}
            title="Plays the bars on screen, one beat per bar: a chord for each proof, silence for a rest"
            onClick={() => (playing ? score.current?.stop() : score.current?.play())}
          >
            {playing ? "Stop" : "Play it back"}
          </button>
        </span>
      </div>
      <Score
        ref={score}
        bars={a.bars}
        current={a.epoch.current}
        settled={a.epoch.settled}
        progress={progress}
        clawback={Number(formatUnits(perBar, qd))}
        tempoMs={BLOCK_MS}
        blocksPerBar={a.terms.epochBlocks}
        variant="hero"
        sound
        onPlaying={setPlaying}
      />
      <p className="caption">
        How to read it: each bar is one epoch. A chord is the vault&apos;s best bid (lower note) and best ask (upper note), resting on
        Kuru and proven in the same transaction; the number under it is the spread in basis points. A rest means no quote, and a run
        of them is engraved as one long rest with the count above. Once settled, a rest is circled in red and its retainer goes back
        to the issuer. G.P. marks a venue pause, which is excused.
      </p>
    </div>
  );
}

/** The live agreement's terms as clauses, each next to the code that enforces it. */
export function LiveClauses() {
  const a = useLatest();
  if (!a) return <Skeleton h={300} />;
  const t = a.terms;
  const qd = a.quote.decimals;
  const bd = a.base.decimals;
  const Q = a.quote.symbol;
  const perDay = (a.pay.retainerPerBlock * 86_400_000n) / BigInt(BLOCK_MS);
  const rows: [string, ReactNode, ReactNode, ReactNode][] = [
    ["Spread", <>at most <b>{t.maxSpreadBps} bps</b> between the vault&apos;s best bid and ask</>, "SLALib.enforce, inside requote()", "A wider quote reverts, so it can never count as a proof."],
    ["Depth", <>at least <b>{fmt(t.minDepthQuote, qd, 0)} {Q}</b> on each side within {t.maxSpreadBps} bps of mid</>, "SLALib.enforce, inside requote()", "Measured from the vault's own resting orders, not the whole book."],
    ["Cadence", <>a fresh two-sided quote every <b>{t.epochBlocks} blocks</b> (about {blocksToDuration(t.epochBlocks)})</>, "Heartbeat.record", "One bit per epoch, set only by a successful requote."],
    ["Uptime", <><b>{t.uptimeBps / 100}%</b> of epochs in every {t.uptimeWindowEpochs}-epoch window</>, "Heartbeat.checkEpoch", <>Falling below it slashes {fmt(t.slashAmount, qd, 0)} {Q} of the bond to the issuer.</>],
    ["Retainer", <><b>{fmt(perDay, qd, 2)} {Q}</b> per day, accrued every block</>, "Paystream.settle", "A missed epoch's share is refunded to the issuer when it is settled."],
    ["Inventory", <><b>{fmt(t.baseInventory, bd, 2)} {a.base.symbol}</b> and <b>{fmt(t.quoteInventory, qd, 0)} {Q}</b> in a quote-only vault</>, "InventoryVault", <>Leaves only to the issuer, after {blocksToDuration(t.noticeBlocks)} of notice or at expiry.</>],
  ];
  return (
    <div className="tbl-wrap">
      <table className="clauses cards">
        <thead>
          <tr><th>Clause</th><th>Term in this agreement</th><th>Enforced by</th><th>What happens</th></tr>
        </thead>
        <tbody>
          {rows.map(([k, v, code, what]) => (
            <tr key={k}>
              <td className="head">{k}</td>
              <td data-label="Term" className="value">{v}</td>
              <td data-label="Enforced by" className="code"><code>{code}</code></td>
              <td data-label="What happens" className="muted">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
