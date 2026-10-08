"use client";

import { useSyncExternalStore } from "react";

/**
 * Sound for the score, off until the visitor asks for it (see DESIGN.md, Sound). The staff is read as a treble staff,
 * so a notehead sounds the pitch it is drawn at: step 0 is the bottom line (E4), each step is the next white key, and
 * ledger-line notes keep counting. A proven bar sounds its chord on a piano voice with the top note leading, a rest is
 * silent, and a settled miss makes one pencil stroke. Browsers only start audio from a click, so the engine is built
 * on the first click that asks for sound: Listen, or a playback (which plays once without turning Listen on).
 */
const WHITE = [0, 2, 4, 5, 7, 9, 11];

/** Staff step to MIDI note: step 0 = E4 (64), step 8 = F5 (77), step -2 = C4 on the first ledger line below. */
export function stepMidi(step: number) {
  const n = step + 2; // white keys counted from C4
  return 60 + 12 * Math.floor(n / 7) + WHITE[((n % 7) + 7) % 7];
}

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let hammer: AudioBuffer | null = null;
let on = false;
let solo: symbol | null = null; // while a playback runs, only it is heard
const listeners = new Set<() => void>();

function engine() {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  bus = ctx.createGain();
  bus.gain.value = 0.6;
  // a small hall, then a gentle limiter so chords and the room never clip
  const room = ctx.createConvolver();
  room.buffer = impulse(ctx, 1.8);
  const wet = ctx.createGain();
  wet.gain.value = 0.24;
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -12;
  limit.knee.value = 10;
  limit.ratio.value = 4;
  limit.attack.value = 0.003;
  limit.release.value = 0.25;
  bus.connect(limit);
  bus.connect(room);
  room.connect(wet);
  wet.connect(limit);
  limit.connect(ctx.destination);
  hammer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
  const h = hammer.getChannelData(0);
  for (let i = 0; i < h.length; i++) h[i] = Math.random() * 2 - 1;
  return ctx;
}

function impulse(c: AudioContext, seconds: number) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

export function setSound(next: boolean) {
  on = next;
  if (next) void engine()?.resume();
  else if (!solo) void ctx?.suspend();
  listeners.forEach((l) => l());
}

export function useSound() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
    () => false,
  );
}

/** Start a playback from a click: it is heard even with Listen off, and mutes every other source until released. */
export function takeSolo() {
  solo = Symbol("solo");
  void engine()?.resume();
  return solo;
}
export function releaseSolo(token: symbol) {
  if (solo !== token) return;
  solo = null;
  if (!on) setTimeout(() => !on && !solo && void ctx?.suspend(), 2500); // let the last chord ring out
}

function ready(owner?: symbol) {
  if (solo ? owner !== solo : !on) return null;
  const c = engine();
  return c && bus ? c : null;
}

/** A chord from staff steps, `at` seconds from now. The highest note is the melody and is played a little louder. */
export function playSteps(steps: number[], at = 0, owner?: symbol) {
  const c = ready(owner);
  if (!c || !bus) return;
  const t = c.currentTime + 0.02 + at;
  const top = Math.max(...steps);
  for (const s of steps) piano(c, bus, stepMidi(s), t, s === top ? 0.17 : 0.1);
}

// relative strength of the partials of a struck string, fundamental first
const PARTIALS = [1, 0.42, 0.26, 0.15, 0.09, 0.055, 0.035];

/** A piano note from its partials: a hammer, stiff strings that run slightly sharp, upper partials dying first. */
function piano(c: AudioContext, out: AudioNode, midi: number, t: number, level: number) {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const end = t + 3.2;
  const v = c.createGain();
  v.gain.setValueAtTime(0.0001, t);
  v.gain.exponentialRampToValueAtTime(level, t + 0.005);
  v.gain.exponentialRampToValueAtTime(level * 0.3, t + 0.6);
  v.gain.exponentialRampToValueAtTime(0.0001, end - 0.05);
  // the felt darkens the tone as the note rings
  const felt = c.createBiquadFilter();
  felt.type = "lowpass";
  felt.Q.value = 0.4;
  felt.frequency.setValueAtTime(Math.min(12000, f * 10), t);
  felt.frequency.setTargetAtTime(Math.max(700, f * 2.5), t + 0.01, 0.35);
  v.connect(felt);
  felt.connect(out);
  const strings: [number, number, number][] = PARTIALS.map((a, i) => [f * (i + 1) * Math.sqrt(1 + 0.00035 * (i + 1) ** 2), a, 1.4 / (1 + 0.7 * i)]);
  strings.push([f * 1.0009, 0.35, 1.2]); // a second string a hair sharp, for the slow beat of a real unison
  for (const [freq, amp, decay] of strings) {
    const o = c.createOscillator();
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.setTargetAtTime(0, t, decay);
    o.connect(g);
    g.connect(v);
    o.start(t);
    o.stop(end);
  }
  if (hammer) {
    const n = c.createBufferSource();
    n.buffer = hammer;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = Math.min(4000, f * 6);
    bp.Q.value = 0.8;
    const ng = c.createGain();
    ng.gain.setValueAtTime(level * 0.25, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    n.start(t);
    n.stop(t + 0.04);
  }
}

/** A red pencil drawing its circle: band-passed noise that rises as the loop closes. */
export function playPencil(at = 0, owner?: symbol) {
  const c = ready(owner);
  if (!c || !bus) return;
  const t = c.currentTime + 0.02 + at;
  const len = 0.34;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * len), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(1500, t);
  bp.frequency.linearRampToValueAtTime(3400, t + len);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.08, t + 0.05);
  g.gain.setValueAtTime(0.08, t + len - 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(bp);
  bp.connect(g);
  g.connect(bus);
  src.start(t);
  src.stop(t + len);
}
