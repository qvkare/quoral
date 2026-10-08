"use client";

import { useEffect, useRef, useState } from "react";
import type { Bar } from "@/lib/agreement";
import { setSound, useSound } from "@/lib/sound";
import { Score } from "./Score";

/**
 * The rehearsal: the visitor runs the quoter on the live agreement's terms, at one bar every two seconds.
 * The rules are the contract's: a requote proves the bar only if it is two-sided, within the spread and over the
 * depth; a bar without a proof is a rest, and once settled its retainer goes back to the issuer; the second miss in
 * an uptime window slashes the bond; a venue pause is excused. Nothing here touches the chain.
 */
export type SimTerms = {
  symbol: string;
  maxSpreadBps: number;
  minDepth: number; // per side, quote tokens
  perBar: number; // retainer per bar, quote tokens
  windowBars: number;
  allowedMisses: number;
  slash: number;
  bond: number;
  barLength: string; // the live bar, e.g. "10 min"
};

// the live testnet agreement's terms, used until they are read from the chain
export const DEFAULT_TERMS: SimTerms = {
  symbol: "USDC",
  maxSpreadBps: 50,
  minDepth: 10_000,
  perBar: 18.81,
  windowBars: 12,
  allowedMisses: 1,
  slash: 500,
  bond: 10_000,
  barLength: "10 min",
};

const BAR_MS = 2000;
const TICKS = [0.1, 0.3, 0.5, 0.7, 0.9]; // when the simulated quoter tries to requote within a bar
const SETTLE_AT = 0.4; // the keeper settles the bar before this far into the next one
const KEEP = 40;

type Sim = {
  bars: Bar[];
  current: number;
  settled: number;
  mid: number;
  tick: number; // last quoter tick tried in the current bar
  paid: number; // settled bars paid to the market maker (quoted or excused)
  returned: number; // settled bars without a quote
  slashes: number;
  slashedIn?: number; // bar in which the last slash happened
  misses: Record<number, number>; // per uptime window
};

const fresh = (): Sim => ({ bars: [{ epoch: 0n, status: 0 }], current: 0, settled: 0, mid: 4120, tick: -1, paid: 0, returned: 0, slashes: 0, misses: {} });
const amount = (v: number, dp = 2) => v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function Rehearsal({ terms: T = DEFAULT_TERMS }: { terms?: SimTerms }) {
  const sound = useSound();
  const [quoting, setQuoting] = useState(true);
  const [spread, setSpread] = useState(Math.round(T.maxSpreadBps * 0.6));
  const [depth, setDepth] = useState(Math.round((T.minDepth * 1.2) / 500) * 500);
  const [paused, setPaused] = useState(false);
  const controls = useRef({ quoting, spread, depth, paused, T });
  controls.current = { quoting, spread, depth, paused, T };

  const sim = useRef<Sim>(fresh());
  const clock = useRef(0); // ms into the current bar
  const [, setFrame] = useState(0);

  // run only while on screen and in a visible tab; with reduced motion, only after the visitor starts it
  const box = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [inView, setInView] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    setStarted(!m.matches);
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.2 });
    if (box.current) io.observe(box.current);
    const vis = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", vis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  const running = started && inView && tabVisible;

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      advance(sim.current, Math.min(100, now - last));
      last = now;
      setFrame((f) => (f + 1) % 1_000_000);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  function advance(s: Sim, dt: number) {
    const { T: terms } = controls.current;
    clock.current += dt;
    const p = clock.current / BAR_MS;
    while (s.tick + 1 < TICKS.length && p >= TICKS[s.tick + 1]) {
      s.tick++;
      requote(s);
    }
    if (p >= SETTLE_AT && s.settled < s.current) settle(s, terms);
    if (p >= 1) {
      clock.current -= BAR_MS;
      s.current++;
      s.tick = -1;
      s.mid *= 1 + (Math.random() - 0.5) * 0.004; // the market moves up to 20 bps a bar
      s.bars = [...s.bars.slice(-(KEEP - 1)), { epoch: BigInt(s.current), status: 0 }];
    }
  }

  /** One quoter tick: the requote either proves the bar or reverts, exactly as SLALib would decide. */
  function requote(s: Sim) {
    const { quoting: q, spread: sp, depth: d, paused: ps, T: terms } = controls.current;
    const bar = s.bars[s.bars.length - 1];
    if (bar.status !== 0) return;
    let next: Bar | undefined;
    if (ps) next = { epoch: bar.epoch, status: 2 }; // anyone may flag the pause; the bar is excused
    else if (q && sp <= terms.maxSpreadBps && d >= terms.minDepth) {
      const half = sp / 2 / 1e4;
      next = { epoch: bar.epoch, status: 1, bid: s.mid * (1 - half), ask: s.mid * (1 + half), spreadBps: sp };
    }
    if (next) s.bars = [...s.bars.slice(0, -1), next];
  }

  /** The keeper's checkEpoch: pay proven and excused bars, return the retainer of the rest, slash on a breach. */
  function settle(s: Sim, terms: SimTerms) {
    for (let e = s.settled; e < s.current; e++) {
      const i = s.bars.findIndex((b) => b.epoch === BigInt(e));
      const b = s.bars[i];
      if (b && (b.status === 1 || b.status === 2)) {
        s.paid++;
        continue;
      }
      s.returned++;
      if (b) s.bars = s.bars.map((x, j) => (j === i ? { ...x, status: 3 } : x));
      const w = Math.floor(e / terms.windowBars);
      s.misses[w] = (s.misses[w] ?? 0) + 1;
      if (s.misses[w] === terms.allowedMisses + 1) {
        s.slashes++;
        s.slashedIn = s.current;
      }
    }
    s.settled = s.current;
  }

  function reset() {
    sim.current = fresh();
    clock.current = 0;
    setQuoting(true);
    setPaused(false);
    setSpread(Math.round(T.maxSpreadBps * 0.6));
    setDepth(Math.round((T.minDepth * 1.2) / 500) * 500);
    setStarted(true);
    setFrame((f) => f + 1);
  }

  const s = sim.current;
  const w = Math.floor(s.current / T.windowBars);
  const settledInWindow = Math.max(0, s.settled - w * T.windowBars);
  const missesInWindow = s.misses[w] ?? 0;
  const uptime = settledInWindow > 0 ? ((settledInWindow - missesInWindow) / settledInWindow) * 100 : 100;
  const bond = Math.max(0, T.bond - s.slashes * T.slash);
  const spreadBad = spread > T.maxSpreadBps;
  const depthBad = depth < T.minDepth;
  const justSlashed = s.slashedIn !== undefined && s.current - s.slashedIn < 2;

  const say = justSlashed
    ? { text: `Second miss in this ${T.windowBars}-bar window: ${amount(T.slash, 0)} ${T.symbol} of the bond is slashed to the issuer.`, bad: true }
    : paused
      ? { text: "Kuru has paused the market. These bars are marked G.P. and excused, so the market maker is still paid.", bad: false }
      : !quoting
        ? { text: `No quote, no proof. Each empty bar sends its ${amount(T.perBar)} ${T.symbol} back to the issuer when it settles.`, bad: true }
        : spreadBad
          ? { text: `The requote reverts: ${spread} bps is wider than the ${T.maxSpreadBps} bps in the terms, so it never counts.`, bad: true }
          : depthBad
            ? { text: `The requote reverts: ${amount(depth, 0)} ${T.symbol} a side is less than the ${amount(T.minDepth, 0)} in the terms.`, bad: true }
            : { text: "Quoting inside the terms. Each bar is proven in the quote transaction and paid when it settles.", bad: false };

  const spreadMax = Math.max(100, T.maxSpreadBps * 2);
  const depthMin = Math.max(500, Math.round((T.minDepth * 0.2) / 500) * 500);
  const depthMax = Math.round((T.minDepth * 2) / 500) * 500;

  return (
    <div className="rehearsal" ref={box}>
      <div className="rehearsal-head">
        <h2>Rehearsal</h2>
        <button type="button" className="sound" aria-pressed={sound} onClick={() => setSound(!sound)}>
          {sound ? "Sound on" : "Sound off"}
        </button>
      </div>
      <p className="intro">
        You run the quoter on the live terms, at two seconds a bar instead of {T.barLength}. Nothing goes onchain; the real score is
        below.
      </p>

      <Score
        bars={s.bars}
        current={BigInt(s.current)}
        settled={BigInt(s.settled)}
        progress={clock.current / BAR_MS}
        clawback={T.perBar}
        variant="full"
        sound
      />

      <p className={`say ${say.bad ? "bad" : ""}`} aria-live="polite">{say.text}</p>

      {reduced && !started ? (
        <button type="button" className="primary" onClick={() => setStarted(true)}>Run the rehearsal</button>
      ) : (
        <div className="sim-actions">
          <button type="button" className={quoting ? "danger" : ""} onClick={() => setQuoting(!quoting)}>
            {quoting ? "Stop the quotes" : "Quote again"}
          </button>
          <button type="button" className="ghost" onClick={reset}>Start over</button>
        </div>
      )}

      <Slider
        label="Spread"
        value={spread}
        min={5}
        max={spreadMax}
        step={1}
        limit={T.maxSpreadBps}
        show={`${spread} bps`}
        note={`at most ${T.maxSpreadBps}`}
        bad={spreadBad}
        onChange={setSpread}
      />
      <Slider
        label="Depth"
        value={depth}
        min={depthMin}
        max={depthMax}
        step={500}
        limit={T.minDepth}
        show={`${amount(depth, 0)} ${T.symbol}`}
        note={`a side, at least ${amount(T.minDepth, 0)}`}
        bad={depthBad}
        onChange={setDepth}
      />
      <label className="check">
        <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
        Kuru pauses the market
      </label>

      <dl className="sim-ledger">
        <dt>Paid to the market maker</dt>
        <dd>{amount(s.paid * T.perBar)} {T.symbol}</dd>
        <dt>Returned to the issuer</dt>
        <dd className={s.returned > 0 ? "pencil" : ""}>{amount(s.returned * T.perBar)} {T.symbol}</dd>
        <dt>Uptime, this {T.windowBars}-bar window</dt>
        <dd className={missesInWindow > T.allowedMisses ? "pencil" : ""}>
          {uptime.toFixed(0)}%<small>{T.allowedMisses === 1 ? "one miss" : `${T.allowedMisses} misses`} allowed</small>
        </dd>
        <dt>Bond</dt>
        <dd className={s.slashes > 0 ? "pencil" : ""}>
          {amount(bond, 0)} {T.symbol}
          {s.slashes > 0 && <small>{amount(s.slashes * T.slash, 0)} slashed</small>}
        </dd>
      </dl>
    </div>
  );
}

function Slider(p: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  limit: number;
  show: string;
  note: string;
  bad: boolean;
  onChange: (v: number) => void;
}) {
  const at = (p.limit - p.min) / (p.max - p.min);
  return (
    <label className="sim-row">
      <span>{p.label}</span>
      <span className="range">
        <input
          type="range"
          min={p.min}
          max={p.max}
          step={p.step}
          value={p.value}
          aria-label={p.label}
          aria-valuetext={`${p.show}, the terms allow ${p.note}`}
          onChange={(e) => p.onChange(Number(e.target.value))}
        />
        {/* the term itself, drawn as a barline on the track */}
        <span className="limit" style={{ left: `calc(7px + (100% - 14px) * ${at})` }} aria-hidden="true" />
      </span>
      <output className={p.bad ? "bad" : ""}>
        {p.show}
        <small>{p.note}</small>
      </output>
    </label>
  );
}
