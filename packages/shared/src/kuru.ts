/** Kuru v1 addresses (verified from docs / onchain, Oct 2026). */
export const KURU = {
  143: {
    router: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC",
    marginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
    forwarder: "0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA",
    monadDeployer: "0xe29309e308af3EE3B1a414E97c37A58509f27D1E",
  },
} as const;

export type MarketScale = {
  pricePrecision: bigint;
  sizePrecision: bigint;
  baseDecimals: bigint;
  quoteDecimals: bigint;
  tickSize: bigint;
  minSize: bigint;
  maxSize: bigint;
};

/** Kuru price units → float quote-per-base */
export const toPrice = (p: bigint | number, s: MarketScale) => Number(p) / Number(s.pricePrecision);
/** float price → Kuru price units, snapped to tick (down for bids, up for asks) */
export function fromPrice(price: number, s: MarketScale, side: "bid" | "ask"): bigint {
  const raw = price * Number(s.pricePrecision);
  const tick = Number(s.tickSize);
  const snapped = side === "bid" ? Math.floor(raw / tick) * tick : Math.ceil(raw / tick) * tick;
  return BigInt(Math.max(snapped, tick));
}
/** float base amount → Kuru size units */
export const fromSize = (base: number, s: MarketScale) => BigInt(Math.floor(base * Number(s.sizePrecision)));
/** quote notional (raw quote units) of a price/size, mirroring SLALib.notional */
export const notional = (price: bigint, size: bigint, s: MarketScale) =>
  (price * size * 10n ** s.quoteDecimals) / (s.pricePrecision * s.sizePrecision);

/** Kuru bestBidAsk sentinels: empty bid = uint256.max, empty ask = 0 (1e18-scaled otherwise). */
export function parseBestBidAsk(bid: bigint, ask: bigint) {
  const MAX = (1n << 256n) - 1n;
  return {
    bid: bid === MAX || bid === 0n ? undefined : Number(bid) / 1e18,
    ask: ask === 0n || ask === MAX ? undefined : Number(ask) / 1e18,
  };
}
