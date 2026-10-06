"use client";

import { useState, type ReactNode } from "react";
import type { Hash } from "viem";
import { errMsg } from "@/lib/hooks";
import { explorerTx } from "@/lib/chain";

export function Skeleton({ h = 18, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} aria-hidden="true" />;
}

/** Ruled row of figures; a `pencil` value marks money that moved because the SLA failed. */
export function Ledger({ items }: { items: { k: string; v: ReactNode; s?: ReactNode; pencil?: boolean }[] }) {
  return (
    <div className="ledger">
      {items.map((it) => (
        <div key={it.k}>
          <div className="k">{it.k}</div>
          <div className={`v ${it.pencil ? "pencil" : ""}`}>{it.v}</div>
          {it.s && <div className="s">{it.s}</div>}
        </div>
      ))}
    </div>
  );
}

/** Legacy single figure, rendered as a ledger cell. */
export function Stat({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- status glyphs (music notation) */
const ChordGlyph = () => (
  <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
    <ellipse cx="5" cy="12.5" rx="3.6" ry="2.5" transform="rotate(-20 5 12.5)" fill="currentColor" />
    <ellipse cx="5" cy="7.5" rx="3.6" ry="2.5" transform="rotate(-20 5 7.5)" fill="currentColor" />
    <line x1="8.3" x2="8.3" y1="12" y2="0.5" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);
const RestGlyph = () => (
  <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
    <line x1="0" x2="16" y1="2.5" y2="2.5" stroke="currentColor" strokeWidth="1" opacity=".5" />
    <rect x="4" y="2.5" width="8" height="4" fill="currentColor" />
  </svg>
);
const FinalGlyph = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
    <rect x="1" y="0" width="1.2" height="14" fill="currentColor" />
    <rect x="5" y="0" width="4" height="14" fill="currentColor" />
  </svg>
);
const OpenGlyph = () => (
  <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
    <ellipse cx="6" cy="5" rx="4.6" ry="3.2" transform="rotate(-20 6 5)" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

type StatusInput = { live: boolean; finalized: boolean; paused: boolean; epoch: { strip: number[] } };

/**
 * Compliance in ink, failure in pencil. The current epoch is legitimately empty for a moment after it starts,
 * so an agreement is in compliance when the current *or* previous bar carries a proof.
 */
export function StatusPill({ a }: { a: StatusInput }) {
  const s = a.epoch.strip;
  const cur = s[s.length - 1];
  const prev = s[s.length - 2];
  if (a.finalized) return <span className="pill idle"><FinalGlyph />Finalized</span>;
  if (!a.live) return <span className="pill idle"><FinalGlyph />Ended, settling</span>;
  if (a.paused) return <span className="pill warn"><span className="marking" style={{ fontWeight: 600 }}>G.P.</span>Venue paused, excused</span>;
  if (cur === 1 || prev === 1) return <span className="pill"><ChordGlyph />Quoting in compliance</span>;
  if (prev === undefined || (prev === 0 && cur === 0 && s.length <= 2)) return <span className="pill idle"><OpenGlyph />Waiting for the first quote</span>;
  return <span className="pill bad"><RestGlyph />No quote, retainer being clawed back</span>;
}

/** Runs a tx and shows pending / error / success inline. */
export function TxButton({
  label,
  run,
  className = "",
  disabled,
  onDone,
  pendingLabel = "Confirming",
}: {
  label: string;
  run: () => Promise<Hash | Hash[] | void>;
  className?: string;
  disabled?: boolean;
  onDone?: () => void;
  pendingLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [hash, setHash] = useState<string>();
  return (
    <span className="stack" style={{ gap: 6, display: "inline-flex", minWidth: 0 }}>
      <button
        className={className}
        disabled={busy || disabled}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setErr(undefined);
          setHash(undefined);
          try {
            const h = await run();
            const last = Array.isArray(h) ? h[h.length - 1] : h;
            if (last) setHash(last);
            onDone?.();
          } catch (e) {
            setErr(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <span className="spinner" />}
        {busy ? pendingLabel : label}
      </button>
      {err && <span className="err" role="alert">{err}</span>}
      {hash && (
        <span className="okmsg" role="status">
          Confirmed in{" "}
          {explorerTx(hash) ? (
            <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mono">{hash.slice(0, 10)}</a>
          ) : (
            <span className="mono">{hash.slice(0, 10)}</span>
          )}
        </span>
      )}
    </span>
  );
}

export function PageHead({ crumb, title, sub, right }: { crumb?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        {crumb && <div className="crumbs">{crumb}</div>}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {right}
    </div>
  );
}
