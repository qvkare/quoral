"use client";

import { useSyncExternalStore } from "react";

/**
 * Sound for the score, off until the visitor turns it on (see DESIGN.md, Sound). The staff is read as a treble
 * staff, so a notehead sounds the pitch it is drawn at, bottom line E4 to top line F5. A proven bar sounds its chord,
 * a rest is silent, and a settled miss makes one pencil stroke. Browsers only start audio from a click, so the
 * engine is built on the first click that asks for sound: the Sound toggle, or a playback (which plays once, on its
 * own, without turning the toggle on).
 */
const STEP_MIDI = [64, 65, 67, 69, 71, 72, 74, 76, 77]; // E4 F4 G4 A4 B4 C5 D5 E5 F5

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let on = false;
let solo: symbol | null = null; // while a playback runs, only it is heard
const listeners = new Set<() => void>();

function engine() {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  bus = ctx.createGain();
  bus.gain.value = 0.55;
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 2600;
  // a short room, so the notes ring like a small hall instead of a test tone
  const room = ctx.createConvolver();
  room.buffer = impulse(ctx, 1.6);
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  bus.connect(tone);
  tone.connect(ctx.destination);
  tone.connect(room);
  room.connect(wet);
  wet.connect(ctx.destination);
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

/** Start a playback from a click: it is heard even with the toggle off, and mutes every other source until released. */
export function takeSolo() {
  solo = Symbol("solo");
  void engine()?.resume();
  return solo;
}
export function releaseSolo(token: symbol) {
  if (solo !== token) return;
  solo = null;
  if (!on) setTimeout(() => !on && !solo && void ctx?.suspend(), 1600); // let the last chord ring out
}

function ready(owner?: symbol) {
  if (solo ? owner !== solo : !on) return null;
  const c = engine();
  return c && bus ? c : null;
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A chord from staff steps (0 = bottom line, 8 = top line), `at` seconds from now. */
export function playSteps(steps: number[], at = 0, owner?: symbol) {
  const c = ready(owner);
  if (!c || !bus) return;
  const t = c.currentTime + 0.02 + at;
  const level = 0.2 / Math.max(1, steps.length);
  for (const s of steps) voice(c, bus, hz(STEP_MIDI[Math.max(0, Math.min(8, s))]), t, 1.3, level);
}

function voice(c: AudioContext, out: AudioNode, f: number, t: number, len: number, level: number) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + 0.012);
  g.gain.exponentialRampToValueAtTime(level * 0.32, t + 0.28);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  g.connect(out);
  const partials: [number, OscillatorType, number][] = [
    [1, "sine", 1],
    [1, "triangle", 0.22],
    [2, "sine", 0.14],
  ];
  for (const [mult, type, amp] of partials) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f * mult;
    const pg = c.createGain();
    pg.gain.value = amp;
    o.connect(pg);
    pg.connect(g);
    o.start(t);
    o.stop(t + len + 0.05);
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
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
  g.gain.setValueAtTime(0.09, t + len - 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(bp);
  bp.connect(g);
  g.connect(bus);
  src.start(t);
  src.stop(t + len);
}
