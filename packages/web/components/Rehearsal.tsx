"use client";

import { useEffect, useRef, useState } from "react";
import type { Bar } from "@/lib/agreement";
import { setSound, useSound } from "@/lib/sound";
import { Score } from "./Score";

/**
 * The rehearsal: the visitor runs the quoter on the live agreement's terms while the simulated price follows a
 * melody, one note per bar. The quote's ask is the melody and its bid sits the spread below, so a proven bar sounds
 * the tune with a harmony under it. The rules are the contract's: a requote proves the bar only if it is two-sided,
 * within the spread and over the depth; a bar without a proof is a rest, and once settled its retainer goes back to
 * the issuer; the second miss in an uptime window slashes the bond; a venue pause is excused. Nothing here touches
 * the chain.
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

/** A melody as [staff step, beats]: step 0 is E4 on the bottom line, 5 is C5, 10 is A5 on the first ledger line. */
type Piece = { id: string; title: string; beatMs: number; notes: [number, number][] };

// Public-domain melodies, all in C major so every note is a white key on the staff.
const TWINKLE_A: [number, number][] = [[5, 1], [5, 1], [9, 1], [9, 1], [10, 1], [10, 1], [9, 2]];
const TWINKLE_B: [number, number][] = [[8, 1], [8, 1], [7, 1], [7, 1], [6, 1], [6, 1], [5, 2]];
const TWINKLE_C: [number, number][] = [[9, 1], [9, 1], [8, 1], [8, 1], [7, 1], [7, 1], [6, 2]];
const JOY: [number, number][] = [[7, 1], [7, 1], [8, 1], [9, 1], [9, 1], [8, 1], [7, 1], [6, 1], [5, 1], [5, 1], [6, 1], [7, 1]];
const PIECES: Piece[] = [
  {
    id: "k265",
    title: "Mozart: Ah vous dirai-je, maman",
    beatMs: 620,
    notes: [...TWINKLE_A, ...TWINKLE_B, ...TWINKLE_C, ...TWINKLE_C, ...TWINKLE_A, ...TWINKLE_B],
  },
  {
    id: "k525",
    title: "Mozart: Eine kleine Nachtmusik",
    beatMs: 540, // the opening, a fourth up from G so it needs no sharps
    notes: [[5, 1.5], [2, 0.5], [5, 1.5], [2, 0.5], [5, 0.5], [2, 0.5], [5, 0.5], [7, 0.5], [9, 2], [8, 1.5], [6, 0.5], [8, 1.5], [6, 0.5], [8, 0.5], [6, 0.5], [4, 0.5], [6, 0.5], [2, 2]],
  },
  {
    id: "joy",
    title: "Beethoven: Ode to Joy",
    beatMs: 600,
    notes: [...JOY, [7, 1.5], [6, 0.5], [6, 2], ...JOY, [6, 1.5], [5, 0.5], [5, 2]],
  },
];

// the price scale behind the staff: the middle line is REF, each step 12.5 bps, so a 25 bps spread is a third
const REF = 4120;
const BPS_PER_STEP = 12.5;
const priceOf = (step: number) => REF * (1 + ((step - 4) * BPS_PER_STEP) / 1e4);

const TICKS = [0.02, 0.25, 0.5, 0.75]; // when the simulated quoter tries to requote within a bar
const SETTLE_AT = 0.4; // the keeper settles the bar before this far into the next one
const KEEP = 40;

type Sim = {
  bars: Bar[];
  current: number;
  settled: number;
  note: number; // index of this bar's note in the piece
  barMs: number; // length of this bar: its note's length
  restart: boolean; // start the piece over at the next bar
  tick: number; // last quoter tick tried in the current bar
  paid: number; // settled bars paid to the market maker (quoted or excused)
  returned: number; // settled bars without a quote
  slashes: number;
  slashedIn?: number; // bar in which the last slash happened
  misses: Record<number, number>; // per uptime window
};

const fresh = (p: Piece): Sim => ({
  bars: [{ epoch: 0n, status: 0 }],
  current: 0,
  settled: 0,
  note: 0,
  barMs: p.notes[0][1] * p.beatMs,
  restart: false,
  tick: -1,
  paid: 0,
  returned: 0,
  slashes: 0,
  misses: {},
});
const amount = (v: number, dp = 2) => v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function Rehearsal({ terms: T = DEFAULT_TERMS }: { terms?: SimTerms }) {
  const sound = useSound();
  const [pieceId, setPieceId] = useState(PIECES[0].id);
  const piece = PIECES.find((p) => p.id === pieceId) ?? PIECES[0];
  const [quoting, setQuoting] = useState(true);
  const [spread, setSpread] = useState(Math.round(T.maxSpreadBps * 0.6));
  const [depth, setDepth] = useState(Math.round((T.minDepth * 1.2) / 500) * 500);
  const [paused, setPaused] = useState(false);
  const controls = useRef({ quoting, spread, depth, paused, T, piece });
  controls.current = { quoting, spread, depth, paused, T, piece };

  const sim = useRef<Sim>(fresh(piece));
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
    const { T: terms, piece: p } = controls.current;
    clock.current += dt;
    const progress = clock.current / s.barMs;
    while (s.tick + 1 < TICKS.length && progress >= TICKS[s.tick + 1]) {
      s.tick++;
      requote(s);
    }
    if (progress >= SETTLE_AT && s.settled < s.current) settle(s, terms);
    if (progress >= 1) {
      clock.current -= s.barMs;
      s.current++;
      s.tick = -1;
      s.note = s.restart ? 0 : (s.note + 1) % p.notes.length;
      s.restart = false;
      s.barMs = p.notes[s.note][1] * p.beatMs;
      s.bars = [...s.bars.slice(-(KEEP - 1)), { epoch: BigInt(s.current), status: 0 }];
    }
  }

  /** One quoter tick: the requote either proves the bar or reverts, exactly as SLALib would decide. */
  function requote(s: Sim) {
    const { quoting: q, spread: sp, depth: d, paused: ps, T: terms, piece: p } = controls.current;
    const bar = s.bars[s.bars.length - 1];
    if (bar.status !== 0) return;
    let next: Bar | undefined;
    if (ps) next = { epoch: bar.epoch, status: 2 }; // anyone may flag the pause; the bar is excused
    else if (q && sp <= terms.maxSpreadBps && d >= terms.minDepth) {
      const ask = priceOf(p.notes[s.note % p.notes.length][0]);
      next = { epoch: bar.epoch, status: 1, bid: ask * (1 - sp / 1e4), ask, spreadBps: sp };
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
    sim.current = fresh(piece);
    clock.current = 0;
    setQuoting(true);
    setPaused(false);
    setSpread(Math.round(T.maxSpreadBps * 0.6));
    setDepth(Math.round((T.minDepth * 1.2) / 500) * 500);
    setStarted(true);
    setFrame((f) => f + 1);
  }

  function listen() {
    if (!sound) sim.current.restart = true; // hear the tune from its first note
    setSound(!sound);
  }

  const s = sim.current;
  const w = Math.floor(s.current / T.windowBars);
  const settledInWindow = Math.max(0, s.settled - w * T.windowBars);
  const missesInWindow = s.misses[w] ?? 0;
  const uptime = settledInWindow > 0 ? ((settledInWindow - missesInWindow) / settledInWindow) * 100 : 100;
  const bond = Math.max(0, T.bond - s.slashes * T.slash);
  const spreadBad = spread > T.maxSpreadBps;
  const depthBad = depth < T.minDepth;
  const justSlashed = s.slashedIn !== undefined && s.current - s.slashedIn < 4;

  const say = justSlashed
    ? { text: `Second miss in this ${T.windowBars}-bar window: ${amount(T.slash, 0)} ${T.symbol} of the bond is slashed to the issuer.`, bad: true }
    : paused
      ? { text: "Kuru has paused the market. These bars are marked G.P. and excused, so the market maker is still paid.", bad: false }
      : !quoting
        ? { text: `No quote, no proof, no music. Each empty bar sends its ${amount(T.perBar)} ${T.symbol} back to the issuer when it settles.`, bad: true }
        : spreadBad
          ? { text: `The requote reverts: ${spread} bps is wider than the ${T.maxSpreadBps} bps in the terms, so it never counts.`, bad: true }
          : depthBad
            ? { text: `The requote reverts: ${amount(depth, 0)} ${T.symbol} a side is less than the ${amount(T.minDepth, 0)} in the terms.`, bad: true }
            : { text: "Quoting inside the terms: each bar is proven in the quote transaction and paid when it settles. Widen the spread and the harmony opens.", bad: false };

  const spreadMax = Math.max(100, T.maxSpreadBps * 2);
  const depthMin = Math.max(500, Math.round((T.minDepth * 0.2) / 500) * 500);
  const depthMax = Math.round((T.minDepth * 2) / 500) * 500;

  return (
    <div className="rehearsal" ref={box}>
      <div className="rehearsal-head">
        <h2>Rehearsal</h2>
        <div className="rehearsal-tools">
          <select
            aria-label="Melody the price follows"
            value={pieceId}
            onChange={(e) => {
              setPieceId(e.target.value);
              sim.current.restart = true;
            }}
          >
            {PIECES.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
          <button type="button" className="sound" onClick={listen}>
            {sound ? "Mute" : "Listen"}
          </button>
        </div>
      </div>
      <p className="intro">
        You run the quoter on the live terms, but here the price follows a melody and a bar lasts one note instead of{" "}
        {T.barLength}. Keep quoting and the tune plays; stop and it breaks. Nothing goes onchain; the real score is below.
      </p>

      <Score
        bars={s.bars}
        current={BigInt(s.current)}
        settled={BigInt(s.settled)}
        progress={clock.current / s.barMs}
        clawback={T.perBar}
        variant="full"
        pitch={{ ref: REF, bpsPerStep: BPS_PER_STEP }}
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
