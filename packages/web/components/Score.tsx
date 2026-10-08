"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Bar } from "@/lib/agreement";
import { playPencil, playSteps, releaseSolo, takeSolo, type Voice } from "@/lib/sound";

/**
 * The agreement drawn as a choir part (see DESIGN.md).
 *   bar        = epoch
 *   chord      = resting bid (lower note) + ask (upper note), proven in the requote tx
 *   whole rest = no quote; once settled it is circled in red pencil with the clawed-back amount
 *   multirest  = three or more missed bars in a row, engraved as one long rest with the count above
 *   G.P.       = general pause: the venue was paused, the epoch is excused
 * Noteheads snap to staff lines and spaces, and stems follow engraving rules (down above the middle line).
 * In a text score bars keep one width, so a young score shows empty measures ahead of the playhead and fills left to
 * right. Prices are fitted to the staff over the visible bars, unless `pitch` fixes the scale (the rehearsal), in which
 * case notes beyond the staff get ledger lines.
 */
type Variant = "hero" | "full" | "mini";
const SPEC: Record<Variant, { g: number; minBar: number; text: boolean }> = {
  hero: { g: 12, minBar: 68, text: true },
  full: { g: 10, minBar: 46, text: true },
  mini: { g: 3.4, minBar: 12, text: false },
};

export type ScoreHandle = { play: () => void; stop: () => void };

export type ScoreProps = {
  bars: Bar[]; // oldest first; the last entry is the current epoch
  current: bigint;
  settled: bigint; // epochs < settled are final
  progress: number; // 0..1 through the current bar
  clawback?: number; // quote tokens returned to the issuer per missed bar
  tempoMs?: number; // block time, shown as ♩ = …
  blocksPerBar?: number;
  variant?: Variant;
  sound?: boolean; // sound new chords and newly settled misses as they arrive, once the visitor turned sound on
  pitch?: { ref: number; bpsPerStep: number }; // fixed scale: `ref` sits on the middle line, each step is `bpsPerStep`
  voice?: Voice;
  onPlaying?: (playing: boolean) => void;
  ref?: Ref<ScoreHandle>;
};

type Item = { kind: "bar"; bar: Bar } | { kind: "multi"; bars: Bar[]; final: boolean };
const slotsOf = (it: Item) => (it.kind === "multi" ? 2 : 1);
const keyOf = (it: Item) => (it.kind === "multi" ? `m${it.bars[0].epoch}` : `b${it.bar.epoch}`);
const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 });

/** Runs of three or more missed bars with the same settlement state become one multirest. */
function group(bars: Bar[], current: bigint, settled: bigint, multi: boolean): Item[] {
  const out: Item[] = [];
  let run: Bar[] = [];
  let runFinal = false;
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "multi", bars: run, final: runFinal });
    else for (const b of run) out.push({ kind: "bar", bar: b });
    run = [];
  };
  for (const b of bars) {
    const miss = multi && b.status !== 1 && b.status !== 2 && b.epoch < current;
    const final = b.epoch < settled;
    if (!miss || (run.length > 0 && final !== runFinal)) flush();
    if (miss) {
      runFinal = final;
      run.push(b);
    } else out.push({ kind: "bar", bar: b });
  }
  flush();
  return out;
}

export function Score({
  bars,
  current,
  settled,
  progress,
  clawback,
  tempoMs,
  blocksPerBar,
  variant = "hero",
  sound = false,
  pitch,
  voice = "piano",
  onPlaying,
  ref,
}: ScoreProps) {
  const spec = SPEC[variant];
  const g = spec.g;
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const stemLen = (spec.text ? 3.3 : 2.4) * g;
  const head = spec.text ? stemLen + 26 : stemLen + 2;
  const top = head;
  const bottom = top + 4 * g;
  const H = bottom + (spec.text ? stemLen + 24 : stemLen + 2);

  // fit whole items from the right; a multirest takes two bar widths. A mini score stretches what it has to the full
  // width; a text score keeps its bar width and leaves the measures to come empty.
  const items = group(bars, current, settled, spec.text);
  const fits = W > 0 ? Math.max(1, Math.floor(W / spec.minBar)) : 0;
  const cap = spec.text ? fits : Math.min(fits, items.reduce((n, it) => n + slotsOf(it), 0));
  let start = items.length;
  let used = 0;
  while (start > 0 && used + slotsOf(items[start - 1]) <= cap) used += slotsOf(items[--start]);
  if (start === items.length && items.length > 0 && cap > 0) used = slotsOf(items[--start]);
  const visible = items.slice(start);
  const bw = cap > 0 ? (W - 1) / cap : 0;
  const slotX: number[] = [];
  visible.reduce((s, it) => (slotX.push(s * bw), s + slotsOf(it)), 0);

  // map a price to a staff step (0 = bottom line, 8 = top line, in half-gaps) over the visible quotes' range
  const shown = visible.flatMap((it) => (it.kind === "bar" ? [it.bar] : it.bars));
  const prices = shown.flatMap((b) => [b.bid, b.ask].filter((p): p is number => p !== undefined));
  let lo = prices.length ? Math.min(...prices) : 0;
  let hi = prices.length ? Math.max(...prices) : 1;
  if (hi - lo < hi * 1e-6) {
    lo -= hi * 0.001 || 1;
    hi += hi * 0.001 || 1;
  }
  const floor = pitch ? -4 : 0;
  const ceil = pitch ? 12 : 8;
  const toStep = (p: number) =>
    Math.max(floor, Math.min(ceil, Math.round(pitch ? ((p / pitch.ref - 1) * 1e4) / pitch.bpsPerStep + 4 : ((p - lo) / (hi - lo)) * 8)));
  /** Staff steps of a proven bar. The voices stay at least a third apart so the noteheads never collide, and the upper
   *  voice keeps its place, since in the rehearsal it carries the melody. */
  const stepsOf = (b: Bar): number[] | null => {
    if (b.status !== 1) return null;
    if (b.bid !== undefined && b.ask !== undefined) {
      let sb = toStep(b.bid);
      let sa = toStep(b.ask);
      if (sa - sb < 2) {
        if (sa - 2 >= floor) sb = sa - 2;
        else sa = sb + 2;
      }
      return [sb, sa];
    }
    const p = b.bid ?? b.ask;
    return p === undefined ? null : [toStep(p)];
  };
  const yOf = (s: number) => bottom - (s * g) / 2;
  const rx = 0.68 * g;
  const ry = 0.47 * g;
  const isMiss = (b: Bar) => b.status !== 1 && b.status !== 2 && b.epoch < current;

  // ---------------------------------------------------------------- sound
  const latest = useRef({ visible, stepsOf, settled, current, tempoMs, onPlaying, voice });
  latest.current = { visible, stepsOf, settled, current, tempoMs, onPlaying, voice };

  // new chords and newly circled rests, as they arrive (never the history on first load)
  const seen = useRef<{ map: Map<string, string>; last: bigint; current: bigint } | null>(null);
  useEffect(() => {
    const prev = seen.current;
    const reset = !prev || current < prev.current;
    const map = reset ? new Map<string, string>() : prev.map;
    const events: { steps: number[]; acc?: number }[] = [];
    for (const b of bars) {
      const k = b.epoch.toString();
      const st = b.status === 1 ? "q" : b.status === 2 ? "p" : isMiss(b) && b.epoch < settled ? "m" : "-";
      const before = map.get(k);
      if (!reset && st !== before && (before !== undefined || b.epoch > prev.last)) {
        if (st === "q") events.push({ steps: latest.current.stepsOf(b) ?? [], acc: b.acc });
        if (st === "m") events.push({ steps: [] });
      }
      map.set(k, st);
    }
    seen.current = { map, last: bars.length ? bars[bars.length - 1].epoch : -1n, current };
    if (!sound) return;
    events.slice(-4).forEach((e, i) => (e.steps.length ? playSteps(e.steps, { at: i * 0.16, acc: e.acc, voice }) : playPencil(i * 0.16)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, settled, current, sound]);

  // playback of the visible bars, one beat per bar at the tempo marking
  const [playing, setPlaying] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const solo = useRef<symbol | null>(null);
  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (solo.current) releaseSolo(solo.current);
    solo.current = null;
    setPlaying(null);
    latest.current.onPlaying?.(false);
  };
  const play = () => {
    stop();
    const token = takeSolo();
    solo.current = token;
    const { visible: v, stepsOf: steps, settled: s, tempoMs: tm, voice: vc } = latest.current;
    const beat = Math.max(240, Math.min(600, tm ?? 300));
    let t = 0;
    v.forEach((it) => {
      timers.current.push(
        window.setTimeout(() => {
          setPlaying(keyOf(it));
          if (it.kind === "multi") {
            if (it.final) playPencil(0, token);
          } else {
            const st = steps(it.bar);
            if (st) playSteps(st, { owner: token, acc: it.bar.acc, voice: vc });
            else if (isMiss(it.bar) && it.bar.epoch < s) playPencil(0, token);
          }
        }, t),
      );
      t += beat * slotsOf(it);
    });
    timers.current.push(window.setTimeout(stop, t + 300));
    latest.current.onPlaying?.(true);
  };
  useImperativeHandle(ref, () => ({ play, stop }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => stop(), []);

  // ---------------------------------------------------------------- drawing
  const quoted = shown.filter((b) => b.status === 1).length;
  const missed = shown.filter(isMiss).length;
  const label = `Score of the last ${shown.length} epochs: ${quoted} quoted, ${missed} without a quote.`;

  const numberEvery = cap > 18 ? 4 : cap > 9 ? 2 : 1;
  const tempoW = spec.text && tempoMs !== undefined ? (blocksPerBar ? 196 : 96) : 0; // keep bar numbers clear of the marking
  const last = visible[visible.length - 1];
  const lastIsCurrent = last?.kind === "bar" && last.bar.epoch === current;

  return (
    <div className="score" ref={box} style={{ height: H }}>
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

          {visible.map((it, i) => {
            const x = slotX[i];
            const w = bw * slotsOf(it);
            const cx = x + w / 2;
            const hit = (title: string) => (
              <rect className={`hit ${playing === keyOf(it) ? "on" : ""}`} x={x} y={0} width={w} height={H}>
                <title>{title}</title>
              </rect>
            );

            if (it.kind === "multi") {
              const first = it.bars[0].epoch;
              const lastEpoch = it.bars[it.bars.length - 1].epoch;
              const n = it.bars.length;
              const amount = clawback !== undefined ? money(clawback * n) : undefined;
              const x0 = x + Math.min(0.22 * w, 20);
              const x1 = x + w - Math.min(0.22 * w, 20);
              const mid = top + 2 * g;
              const cls = it.final ? "" : "unsettled";
              return (
                <g key={`m${first}`}>
                  <line className="barline" x1={x + 0.5} x2={x + 0.5} y1={top} y2={bottom} />
                  <rect className={`rest ${cls}`} x={x0} y={mid - 0.3 * g} width={x1 - x0} height={0.6 * g} />
                  <line className={`rest-edge ${cls}`} x1={x0} x2={x0} y1={top + g} y2={top + 3 * g} />
                  <line className={`rest-edge ${cls}`} x1={x1} x2={x1} y1={top + g} y2={top + 3 * g} />
                  <text className={`multi ${cls}`} x={cx} y={top - 9} textAnchor="middle">{n}</text>
                  {it.final && <PencilCircle cx={cx} cy={mid} rx={(x1 - x0) / 2 + 0.9 * g} ry={1.75 * g} seed={Number(first % 997n)} />}
                  {it.final && amount && (
                    <text className="amount" x={cx} y={bottom + stemLen + 14} textAnchor="middle">
                      {"−"}{amount}
                    </text>
                  )}
                  {hit(
                    `Epochs ${first} to ${lastEpoch}: no quote in ${n} bars` +
                      (it.final ? (amount ? `, ${amount} returned to the issuer` : ", settled") : ", not settled yet"),
                  )}
                </g>
              );
            }

            const b = it.bar;
            const isCurrent = b.epoch === current;
            const past = b.epoch < current;
            const final = b.epoch < settled;
            const showNum = spec.text && Number(b.epoch % BigInt(numberEvery)) === 0 && x + 4 > tempoW;
            const steps = stepsOf(b);
            const per = clawback !== undefined ? money(clawback) : undefined;
            const title =
              b.status === 1
                ? `Epoch ${b.epoch}: bid ${b.bid?.toFixed(2) ?? "none (quote inventory used up)"}, ask ${b.ask?.toFixed(2) ?? "none (base inventory used up)"}, spread ${b.spreadBps} bps${b.block !== undefined ? `, proven at block ${b.block}` : ""}`
                : b.status === 2
                  ? `Epoch ${b.epoch}: venue paused, excused`
                  : isCurrent
                    ? `Epoch ${b.epoch}: in progress, waiting for a quote`
                    : final
                      ? `Epoch ${b.epoch}: no quote${per ? `, ${per} returned to the issuer` : ""}`
                      : `Epoch ${b.epoch}: no quote, not settled yet`;
            return (
              <g key={b.epoch.toString()}>
                <line className="barline" x1={x + 0.5} x2={x + 0.5} y1={top} y2={bottom} />
                {showNum && (
                  <text className="num" x={x + 4} y={top - stemLen - 8}>
                    {b.epoch.toString()}
                  </text>
                )}

                {steps?.length === 2 && <Chord key={`c${b.epoch}`} cx={cx} g={g} rx={rx} ry={ry} stemLen={stemLen} sb={steps[0]} sa={steps[1]} acc={b.acc} yOf={yOf} />}
                {/* one voice: the other side's inventory was used up and the vault posted all it had */}
                {steps?.length === 1 && <Note key={`n${b.epoch}`} cx={cx} g={g} rx={rx} ry={ry} stemLen={stemLen} s={steps[0]} yOf={yOf} />}

                {b.status === 2 && spec.text && (
                  <text className="gp" x={cx} y={top - 10} textAnchor="middle">G.P.</text>
                )}
                {b.status === 2 && !spec.text && <rect x={cx - g} y={top - g} width={2 * g} height={g * 0.4} fill="var(--graphite-2)" />}

                {b.status !== 1 && b.status !== 2 && past && (
                  <g>
                    <rect className={`rest ${final ? "" : "unsettled"}`} x={cx - 0.62 * g} y={top + g} width={1.24 * g} height={0.56 * g} />
                    {final && spec.text && <PencilCircle cx={cx} cy={top + 1.3 * g} rx={1.7 * g} ry={1.3 * g} seed={Number(b.epoch % 997n)} />}
                    {final && spec.text && per && (
                      <text className="amount" x={cx} y={bottom + stemLen + 14} textAnchor="middle">
                        {"−"}{per}
                      </text>
                    )}
                  </g>
                )}

                {b.status === 1 && spec.text && b.spreadBps !== undefined && (
                  <text className="spread" x={cx} y={bottom + stemLen + 14} textAnchor="middle">
                    {b.spreadBps}
                  </text>
                )}

                {hit(title)}
              </g>
            );
          })}

          {/* measures still to come, drawn faint */}
          {Array.from({ length: Math.max(0, cap - used) }, (_, j) => {
            const x = (used + j) * bw;
            return j === 0 && !lastIsCurrent ? null : <line key={`a${j}`} className="barline ahead" x1={x + 0.5} x2={x + 0.5} y1={top} y2={bottom} />;
          })}

          {/* closing barline unless the last visible bar is still being played */}
          {visible.length > 0 && !lastIsCurrent && <line className="barline" x1={used * bw - 0.5} x2={used * bw - 0.5} y1={top} y2={bottom} />}

          {/* playhead */}
          {lastIsCurrent && (
            <line
              className="playhead"
              x1={0}
              x2={0}
              y1={top - (spec.text ? 8 : 2)}
              y2={bottom + (spec.text ? 8 : 2)}
              style={{ transform: `translateX(${(used - 1) * bw + Math.min(0.98, Math.max(0.02, progress)) * bw}px)` }}
            />
          )}
        </svg>
      )}
    </div>
  );
}

function Chord({ cx, g, rx, ry, stemLen, sb, sa, acc, yOf }: { cx: number; g: number; rx: number; ry: number; stemLen: number; sb: number; sa: number; acc?: number; yOf: (s: number) => number }) {
  const yb = yOf(sb);
  const ya = yOf(sa);
  const stemDown = (sa + sb) / 2 >= 4; // engraving rule: above the middle line, stems go down
  const sx = stemDown ? cx - rx * 0.9 : cx + rx * 0.9;
  const sw = Math.max(1, g * 0.09);
  return (
    <g className="fresh">
      <Ledgers cx={cx} rx={rx} steps={[sb, sa]} yOf={yOf} />
      {acc ? (
        <text className="acc" x={cx - rx * 2.1} y={ya + g * 0.45} textAnchor="middle" style={{ fontSize: g * 1.5 }}>
          {acc > 0 ? "\u266f" : "\u266d"}
        </text>
      ) : null}
      <ellipse className="note" cx={cx} cy={yb} rx={rx} ry={ry} transform={`rotate(-20 ${cx} ${yb})`} />
      <ellipse className="note" cx={cx} cy={ya} rx={rx} ry={ry} transform={`rotate(-20 ${cx} ${ya})`} />
      <line className="stem" strokeWidth={sw} x1={sx} x2={sx} y1={stemDown ? ya : yb} y2={stemDown ? yb + stemLen : ya - stemLen} />
    </g>
  );
}

function Note({ cx, g, rx, ry, stemLen, s, yOf }: { cx: number; g: number; rx: number; ry: number; stemLen: number; s: number; yOf: (s: number) => number }) {
  const y = yOf(s);
  const stemDown = s >= 4;
  const sx = stemDown ? cx - rx * 0.9 : cx + rx * 0.9;
  return (
    <g className="fresh">
      <Ledgers cx={cx} rx={rx} steps={[s]} yOf={yOf} />
      <ellipse className="note" cx={cx} cy={y} rx={rx} ry={ry} transform={`rotate(-20 ${cx} ${y})`} />
      <line className="stem" strokeWidth={Math.max(1, g * 0.09)} x1={sx} x2={sx} y1={y} y2={stemDown ? y + stemLen : y - stemLen} />
    </g>
  );
}

/** Short lines through or under noteheads above the top line (step 10 and up) or below the bottom line (-2 and down). */
function Ledgers({ cx, rx, steps, yOf }: { cx: number; rx: number; steps: number[]; yOf: (s: number) => number }) {
  const at = new Set<number>();
  for (const s of steps) {
    for (let l = 10; l <= s; l += 2) at.add(l);
    for (let l = -2; l >= s; l -= 2) at.add(l);
  }
  return (
    <>
      {[...at].map((l) => (
        <line key={l} className="ledger-line" x1={cx - rx * 1.7} x2={cx + rx * 1.7} y1={yOf(l) + 0.5} y2={yOf(l) + 0.5} />
      ))}
    </>
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
