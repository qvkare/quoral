"use client";

import { useEffect, useRef, useState } from "react";
import type { Bar } from "@/lib/agreement";

/**
 * The agreement drawn as a choir part (see DESIGN.md).
 *   bar        = epoch
 *   chord      = resting bid (lower note) + ask (upper note), proven in the requote tx
 *   whole rest = no quote; once settled it is circled in red pencil with the clawed-back amount
 *   G.P.       = general pause: the venue was paused, the epoch is excused
 * Noteheads snap to staff lines and spaces, and stems follow engraving rules (down above the middle line).
 */
type Variant = "hero" | "full" | "mini";
const SPEC: Record<Variant, { g: number; minBar: number; text: boolean }> = {
  hero: { g: 12, minBar: 68, text: true },
  full: { g: 10, minBar: 46, text: true },
  mini: { g: 3.4, minBar: 12, text: false },
};

export type ScoreProps = {
  bars: Bar[]; // oldest first; the last entry is the current epoch
  current: bigint;
  settled: bigint; // epochs < settled are final
  progress: number; // 0..1 through the current bar
  clawback?: string; // amount returned per missed bar, e.g. "0.095"
  tempoMs?: number; // block time, shown as ♩ = …
  blocksPerBar?: number;
  variant?: Variant;
};

export function Score({ bars, current, settled, progress, clawback, tempoMs, blocksPerBar, variant = "hero" }: ScoreProps) {
  const spec = SPEC[variant];
  const g = spec.g;
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const stemLen = (spec.text ? 3.3 : 2.4) * g;
  const head = spec.text ? stemLen + 26 : stemLen + 2;
  const top = head;
  const bottom = top + 4 * g;
  const H = bottom + (spec.text ? stemLen + 24 : stemLen + 2);

  const n = W > 0 ? Math.max(1, Math.min(bars.length, Math.floor(W / spec.minBar))) : 0;
  const visible = bars.slice(-n);
  const bw = n > 0 ? (W - 1) / n : 0;

  // map a price to a staff step (0 = bottom line, 8 = top line, in half-gaps) over the visible quotes' range
  const prices = visible.flatMap((b) => (b.bid !== undefined && b.ask !== undefined ? [b.bid, b.ask] : []));
  let lo = prices.length ? Math.min(...prices) : 0;
  let hi = prices.length ? Math.max(...prices) : 1;
  if (hi - lo < hi * 1e-6) {
    lo -= hi * 0.001 || 1;
    hi += hi * 0.001 || 1;
  }
  const toStep = (p: number) => Math.max(0, Math.min(8, Math.round(((p - lo) / (hi - lo)) * 8)));
  const yOf = (s: number) => bottom - (s * g) / 2;
  const rx = 0.68 * g;
  const ry = 0.47 * g;

  const quoted = visible.filter((b) => b.status === 1).length;
  const missed = visible.filter((b) => b.status !== 1 && b.status !== 2 && b.epoch < current).length;
  const label = `Score of the last ${visible.length} epochs: ${quoted} quoted, ${missed} without a quote.`;

  const numberEvery = n > 18 ? 4 : n > 9 ? 2 : 1;
  const tempoW = spec.text && tempoMs ? 128 : 0;

  return (
    <div className="score" ref={ref} style={{ height: H }}>
      {W > 0 && (
        <svg width={W} height={H} role="img" aria-label={label}>
          {/* staff */}
          {[0, 1, 2, 3, 4].map((i) => (
            <line key={i} className="staff" x1={0} x2={W} y1={top + i * g + 0.5} y2={top + i * g + 0.5} />
          ))}

          {/* tempo marking: ♩ = 300 ms */}
          {spec.text && tempoMs !== undefined && (
            <g aria-hidden="true">
              <ellipse cx={6} cy={15} rx={4.2} ry={2.9} transform="rotate(-20 6 15)" className="note" />
              <line x1={9.6} x2={9.6} y1={14} y2={2} className="stem" strokeWidth={1.1} />
              <text x={16} y={18} className="tempo">
                = {tempoMs >= 1000 ? `${tempoMs / 1000} s` : `${tempoMs} ms`}
                {blocksPerBar ? <tspan className="marking" dx={8} fill="var(--graphite)">{blocksPerBar} to the bar</tspan> : null}
              </text>
            </g>
          )}

          {visible.map((b, i) => {
            const x = i * bw;
            const cx = x + bw / 2;
            const isCurrent = b.epoch === current;
            const past = b.epoch < current;
            const final = b.epoch < settled;
            const showNum = spec.text && i % numberEvery === 0 && x + 4 > tempoW;
            const title =
              b.status === 1
                ? `Epoch ${b.epoch}: bid ${b.bid?.toFixed(2)}, ask ${b.ask?.toFixed(2)}, spread ${b.spreadBps} bps, proven at block ${b.block}`
                : b.status === 2
                  ? `Epoch ${b.epoch}: venue paused, excused`
                  : isCurrent
                    ? `Epoch ${b.epoch}: in progress, waiting for a quote`
                    : final
                      ? `Epoch ${b.epoch}: no quote${clawback ? `, ${clawback} returned to the issuer` : ""}`
                      : `Epoch ${b.epoch}: no quote, not settled yet`;
            return (
              <g key={b.epoch.toString()}>
                <line className="barline" x1={x + 0.5} x2={x + 0.5} y1={top} y2={bottom} />
                {showNum && (
                  <text className="num" x={x + 4} y={top - stemLen - 8}>
                    {b.epoch.toString()}
                  </text>
                )}

                {b.status === 1 && b.bid !== undefined && b.ask !== undefined && (
                  <Chord key={`c${b.epoch}`} cx={cx} g={g} rx={rx} ry={ry} stemLen={stemLen} sb={toStep(b.bid)} sa={toStep(b.ask)} yOf={yOf} />
                )}

                {b.status === 2 && spec.text && (
                  <text className="gp" x={cx} y={top - 10} textAnchor="middle">G.P.</text>
                )}
                {b.status === 2 && !spec.text && <rect x={cx - g} y={top - g} width={2 * g} height={g * 0.4} fill="var(--graphite-2)" />}

                {b.status !== 1 && b.status !== 2 && past && (
                  <g>
                    <rect className={`rest ${final ? "" : "unsettled"}`} x={cx - 0.62 * g} y={top + g} width={1.24 * g} height={0.56 * g} />
                    {final && spec.text && <PencilCircle cx={cx} cy={top + 1.3 * g} rx={1.7 * g} ry={1.3 * g} seed={Number(b.epoch % 997n)} />}
                    {final && spec.text && clawback && (
                      <text className="amount" x={cx} y={bottom + stemLen + 14} textAnchor="middle">
                        {"−"}{clawback}
                      </text>
                    )}
                  </g>
                )}

                {b.status === 1 && spec.text && b.spreadBps !== undefined && (
                  <text className="spread" x={cx} y={bottom + stemLen + 14} textAnchor="middle">
                    {b.spreadBps}
                  </text>
                )}

                <rect className="hit" x={x} y={0} width={bw} height={H}>
                  <title>{title}</title>
                </rect>
              </g>
            );
          })}

          {/* closing barline unless the last visible bar is still being played */}
          {visible.length > 0 && visible[visible.length - 1].epoch !== current && (
            <line className="barline" x1={W - 0.5} x2={W - 0.5} y1={top} y2={bottom} />
          )}

          {/* playhead */}
          {visible.length > 0 && visible[visible.length - 1].epoch === current && (
            <line
              className="playhead"
              x1={0}
              x2={0}
              y1={top - (spec.text ? 8 : 2)}
              y2={bottom + (spec.text ? 8 : 2)}
              style={{ transform: `translateX(${(n - 1) * bw + Math.min(0.98, Math.max(0.02, progress)) * bw}px)` }}
            />
          )}
        </svg>
      )}
    </div>
  );
}

function Chord({ cx, g, rx, ry, stemLen, sb, sa, yOf }: { cx: number; g: number; rx: number; ry: number; stemLen: number; sb: number; sa: number; yOf: (s: number) => number }) {
  // keep at least a third between the voices so the noteheads never collide
  if (sa - sb < 2) {
    if (sb + 2 <= 8) sa = sb + 2;
    else sb = sa - 2;
  }
  const yb = yOf(sb);
  const ya = yOf(sa);
  const stemDown = (sa + sb) / 2 >= 4; // engraving rule: above the middle line, stems go down
  const sx = stemDown ? cx - rx * 0.9 : cx + rx * 0.9;
  const sw = Math.max(1, g * 0.09);
  return (
    <g className="fresh">
      <ellipse className="note" cx={cx} cy={yb} rx={rx} ry={ry} transform={`rotate(-20 ${cx} ${yb})`} />
      <ellipse className="note" cx={cx} cy={ya} rx={rx} ry={ry} transform={`rotate(-20 ${cx} ${ya})`} />
      <line className="stem" strokeWidth={sw} x1={sx} x2={sx} y1={stemDown ? ya : yb} y2={stemDown ? yb + stemLen : ya - stemLen} />
    </g>
  );
}

/** A loose, slightly overshooting red-pencil loop, deterministic per epoch so it doesn't jitter between renders. */
function PencilCircle({ cx, cy, rx, ry, seed }: { cx: number; cy: number; rx: number; ry: number; seed: number }) {
  const rnd = (k: number) => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const start = -0.6 + rnd(1) * 0.5;
  const sweep = Math.PI * 2 + 0.45 + rnd(2) * 0.25;
  const tilt = -0.18 + rnd(3) * 0.12;
  const pts: string[] = [];
  const steps = 36;
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps;
    const wob = 1 + (rnd(10 + i) - 0.5) * 0.06 + (i / steps) * 0.08;
    const px = Math.cos(t) * rx * wob;
    const py = Math.sin(t) * ry * wob;
    const x = cx + px * Math.cos(tilt) - py * Math.sin(tilt);
    const y = cy + px * Math.sin(tilt) + py * Math.cos(tilt);
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return <path className="circle" d={pts.join(" ")} />;
}
