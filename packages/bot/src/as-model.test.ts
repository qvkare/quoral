import { test } from "node:test";
import assert from "node:assert/strict";
import { asQuote, inventoryImbalance, VolEstimator, type ASParams } from "./as-model";

const P: ASParams = { gamma: 0.1, k: 1.5, horizonS: 60, minSpreadBps: 8, spreadSafety: 0.85, levels: 3, depthBuffer: 1.25 };
const SLA = { maxSpreadBps: 50, minDepthQuote: 10_000 };

const bps = (a: number, b: number) => ((a - b) * 2e4) / (a + b);

test("spread never exceeds SLA safety cap, even in high vol", () => {
  const l = asQuote(3900, 0.01, 0, SLA, P);
  assert.ok(l.spreadBps <= 50 * 0.85 + 1e-9);
  assert.ok(bps(l.asks[0].price, l.bids[0].price) <= 50);
});

test("spread floors at minSpreadBps in calm markets", () => {
  const l = asQuote(3900, 0, 0, SLA, P);
  assert.ok(Math.abs(l.spreadBps - 8) < 1e-9);
});

test("all ladder levels sit inside ±maxSpread of our mid and meet depth", () => {
  const l = asQuote(3900, 0.0002, 0.7, SLA, P);
  const mid = (l.bids[0].price + l.asks[0].price) / 2;
  let bidDepth = 0, askDepth = 0;
  for (const b of l.bids) { assert.ok(b.price >= mid * (1 - 50 / 1e4)); bidDepth += b.price * b.size; }
  for (const a of l.asks) { assert.ok(a.price <= mid * (1 + 50 / 1e4)); askDepth += a.price * a.size; }
  assert.ok(bidDepth >= 10_000 && askDepth >= 10_000);
});

test("long inventory skews quotes down (sell more aggressively)", () => {
  const flat = asQuote(3900, 0.0003, 0, SLA, P);
  const long = asQuote(3900, 0.0003, 1, SLA, P);
  const short = asQuote(3900, 0.0003, -1, SLA, P);
  assert.ok(long.reservation < flat.reservation);
  assert.ok(short.reservation > flat.reservation);
});

test("inventory imbalance in [-1,1]", () => {
  assert.equal(inventoryImbalance(10, 39_000, 3900), 0);
  assert.equal(inventoryImbalance(10, 0, 3900), 1);
  assert.equal(inventoryImbalance(0, 5, 3900), -1);
});

test("EWMA vol reacts to returns", () => {
  const v = new VolEstimator(0.5, 0);
  v.update(100, 0);
  v.update(101, 1000);
  assert.ok(v.sigma > 0.005);
});
