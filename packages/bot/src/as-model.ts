/**
 * Avellaneda–Stoikov (2008) quoting with inventory skew, constrained by a Quoral SLA.
 *
 *   reservation  r = s · (1 − q·γ·σ²·τ)
 *   spread       δ = γ·σ²·τ + (2/γ)·ln(1 + γ/k)          (σ, δ in bps; k in 1/bps)
 *
 * q ∈ [−1, 1] is the inventory imbalance (+1 = all base, −1 = all quote) so the model skews quotes to
 * mean-revert inventory. The SLA turns the textbook model into a constrained one: the spread is clamped
 * to `maxSpreadBps · safety` and each side must carry ≥ minDepth·buffer within ±maxSpreadBps of mid.
 */
export type ASParams = {
  gamma: number; // risk aversion
  k: number; // order-arrival intensity decay
  horizonS: number; // τ, seconds
  minSpreadBps: number;
  spreadSafety: number; // fraction of maxSpreadBps we allow ourselves
  levels: number;
  depthBuffer: number;
};

export type SLA = { maxSpreadBps: number; minDepthQuote: number }; // minDepth in quote units (float)

export type Ladder = {
  reservation: number;
  spreadBps: number;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
};

export function inventoryImbalance(baseQty: number, quoteQty: number, mid: number): number {
  const b = baseQty * mid;
  const total = b + quoteQty;
  if (total <= 0) return 0;
  return Math.max(-1, Math.min(1, (b - quoteQty) / total));
}

export function asQuote(mid: number, sigma: number, q: number, sla: SLA, p: ASParams): Ladder {
  // Work in bps so γ and k have intuitive scales (k in 1/bps).
  const varBps = (sigma * 1e4) ** 2 * p.horizonS;
  const rawSpreadBps = p.gamma * varBps + (2 / p.gamma) * Math.log(1 + p.gamma / p.k);
  const maxSpreadBps = sla.maxSpreadBps * p.spreadSafety;
  const spreadBps = Math.min(maxSpreadBps, Math.max(p.minSpreadBps, rawSpreadBps));

  // inventory skew, capped at half the room left inside the SLA band
  const maxSkewBps = Math.max(0, sla.maxSpreadBps - spreadBps / 2) / 2;
  const skewBps = Math.max(-maxSkewBps, Math.min(maxSkewBps, q * p.gamma * varBps));
  const r = mid * (1 - skewBps / 1e4);

  const bestBid = r * (1 - spreadBps / 2e4);
  const bestAsk = r * (1 + spreadBps / 2e4);
  // ladder stays inside ±maxSpread of *our* mid (where SLALib counts depth), with 20% margin
  const roomBps = Math.max(0, sla.maxSpreadBps - spreadBps / 2) * 0.8;
  const stepBps = p.levels > 1 ? roomBps / (p.levels - 1) : 0;
  const perLevelNotional = (sla.minDepthQuote * p.depthBuffer) / p.levels;

  const bids = [];
  const asks = [];
  for (let i = 0; i < p.levels; i++) {
    const bp = bestBid * (1 - (stepBps * i) / 1e4);
    const ap = bestAsk * (1 + (stepBps * i) / 1e4);
    bids.push({ price: bp, size: perLevelNotional / bp });
    asks.push({ price: ap, size: perLevelNotional / ap });
  }
  return { reservation: r, spreadBps, bids, asks };
}

/** EWMA volatility of log returns, per √second. */
export class VolEstimator {
  private varPerS = 0;
  private last?: { px: number; t: number };
  constructor(
    private readonly lambda = 0.94,
    initialSigma = 0.0002,
  ) {
    this.varPerS = initialSigma * initialSigma;
  }
  update(px: number, tMs: number) {
    if (this.last && tMs > this.last.t) {
      const dt = (tMs - this.last.t) / 1000;
      const ret = Math.log(px / this.last.px);
      this.varPerS = this.lambda * this.varPerS + (1 - this.lambda) * ((ret * ret) / dt);
    }
    this.last = { px, t: tMs };
  }
  get sigma() {
    return Math.sqrt(this.varPerS);
  }
}
