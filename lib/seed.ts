/**
 * Simulated history shown in front of the real one until the bot has enough real days
 * for its ratios (Ivan, 2026-09-14: "I don't want to wait seven days"). A seed is the
 * strategy run on real morning prices for the days before launch (scripts/seed.ts).
 *
 * The seed's equity curve is shifted so that it ends exactly where the real curve
 * starts, its deals are listed as finished deals marked "simulated", and both are
 * dropped the moment the real record has SEED_UNTIL_CLOSES daily closes of its own.
 */
import type { SpreadRecord } from './executor.ts';
import { addSample, dealStats, equityStatsFromAgg, type EquityAgg, type EquitySample } from './metrics.ts';

export type Seed = {
  generatedAt: string;
  /** Settlement days covered, inclusive. */
  from: string;
  to: string;
  capitalUsd: number;
  riskPerTradePct: number;
  markets: string[];
  /** Settled deals, each with `simulated: true`. */
  spreads: SpreadRecord[];
  /** One close per day: cumulative simulated P&L at the end of that day. */
  closes: EquitySample[];
};

/** Seven daily returns need eight daily closes. */
export const SEED_UNTIL_CLOSES = 8;

export function seedActive(seed: Seed | undefined, agg: EquityAgg | undefined): seed is Seed {
  return Boolean(seed?.closes.length) && (agg?.closes.length ?? 0) < SEED_UNTIL_CLOSES;
}

/**
 * Metrics, series and deals with the seed in front of the real record. `realSpreads`
 * are the bot's own; `agg` and `realSeries` its own equity record.
 */
export function withSeed(seed: Seed, agg: EquityAgg | undefined, realSeries: EquitySample[], realSpreads: SpreadRecord[]) {
  // Shift the seed so its last close sits exactly on the real curve's first sample.
  const start = agg?.first;
  const capital = start ? start.equityUsd - start.strategyUsd : seed.capitalUsd;
  const offset = (start?.strategyUsd ?? 0) - (seed.closes[seed.closes.length - 1]?.strategyUsd ?? 0);
  const closes = seed.closes.map((c) => ({ t: c.t, strategyUsd: c.strategyUsd + offset, equityUsd: capital + c.strategyUsd + offset }));

  let stats: EquityAgg | undefined;
  for (const s of closes) stats = addSample(stats, s);
  for (const s of agg?.closes ?? []) stats = addSample(stats, s);

  const spreads = [...seed.spreads.map((s) => ({ ...s, simulated: true })), ...realSpreads];
  return {
    equity: equityStatsFromAgg(stats),
    deals: dealStats(spreads),
    series: [...closes, ...realSeries],
    spreads,
    seeded: { days: seed.closes.length, from: seed.from, to: seed.to, deals: seed.spreads.length, markets: seed.markets, realClosesNeeded: SEED_UNTIL_CLOSES, realCloses: agg?.closes.length ?? 0 },
  };
}
