/**
 * The simulated history must join the real record seamlessly, give the ratios their seven
 * daily returns at once, and disappear when the real record is long enough.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpreadRecord } from '../lib/executor.ts';
import { addSample, type EquityAgg, type EquitySample } from '../lib/metrics.ts';
import { seedActive, withSeed, type Seed } from '../lib/seed.ts';

const DAY = 86_400_000;
const day = (n: number) => Date.UTC(2026, 8, 6 + n, 23, 59);

function makeSeed(): Seed {
  const pnls = [120, -400, 150, 130, 140, -350, 160, 110];
  const closes: EquitySample[] = [];
  const spreads: SpreadRecord[] = [];
  let cum = 0;
  pnls.forEach((p, i) => {
    cum += p;
    closes.push({ t: day(i), equityUsd: 100_000 + cum, strategyUsd: cum });
    spreads.push({ id: `sim-BTC-${i}`, market: 'BTC', expiry: '2026-09-07', expiryMs: 0, openedAt: '', entrySpot: 0, shortName: '', shortStrike: 0, longName: '', longStrike: 0, plannedAmount: 1, riskUsd: 1000, accountUsdAtEntry: 100_000, minCreditQuote: 0, amount: 0, spareLong: 0, openedAmount: 2, cashQuote: p, fills: [], creditUsd: 100, maxLossUsd: 400, lossToCredit: 4, status: 'settled', pnlUsd: p, closedAt: '', simulated: true });
  });
  return { generatedAt: '', from: '2026-09-06', to: '2026-09-13', capitalUsd: 100_000, riskPerTradePct: 1, markets: ['BTC'], spreads, closes };
}

function realAgg(days: number, startStrategy = 0): { agg: EquityAgg | undefined; series: EquitySample[] } {
  let agg: EquityAgg | undefined;
  const series: EquitySample[] = [];
  for (let i = 0; i < days; i++) {
    for (let k = 0; k < 3; k++) {
      const s = { t: Date.UTC(2026, 8, 14 + i, 10 + k * 4), equityUsd: 100_000 + startStrategy + i * 50, strategyUsd: startStrategy + i * 50 };
      agg = addSample(agg, s);
      series.push(s);
    }
  }
  return { agg, series };
}

test('the seed alone gives seven daily returns, so Sharpe and Sortino show on day one', () => {
  const { agg, series } = realAgg(1);
  const out = withSeed(makeSeed(), agg, series, []);
  assert.ok(out.equity.dailyReturns >= 7, `${out.equity.dailyReturns} returns`);
  assert.ok(Number.isFinite(out.equity.sharpe));
  assert.ok(Number.isFinite(out.equity.sortino));
  assert.equal(out.deals.deals, 8);
  assert.ok(out.spreads.every((s) => s.simulated));
});

test('the seed is shifted to end exactly where the real curve starts', () => {
  const { agg, series } = realAgg(1, -112);
  const out = withSeed(makeSeed(), agg, series, []);
  const lastSeed = out.series[7];
  assert.equal(lastSeed.strategyUsd, -112);
  assert.equal(lastSeed.equityUsd, 100_000 - 112);
  assert.equal(out.series[8].t, series[0].t);
  // The real record's own change is unaffected by the shift.
  assert.equal(out.series.at(-1)!.strategyUsd, -112);
});

test('the seed shows while the real record has fewer than eight daily closes, then drops out', () => {
  const seed = makeSeed();
  assert.equal(seedActive(seed, undefined), true);
  assert.equal(seedActive(seed, realAgg(7).agg), true);
  assert.equal(seedActive(seed, realAgg(8).agg), false);
  assert.equal(seedActive(undefined, realAgg(1).agg), false);
});

test('once the seed drops out, the metrics come from the real record alone', () => {
  const { agg } = realAgg(8);
  // Not seeded: eight real closes give seven returns of their own.
  assert.equal(seedActive(makeSeed(), agg), false);
  assert.equal(agg!.closes.length, 8);
});
