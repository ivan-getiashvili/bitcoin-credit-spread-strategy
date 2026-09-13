import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpreadRecord } from '../lib/executor.ts';
import { dealStats, downsample, equityStats, type EquitySample } from '../lib/metrics.ts';

const deal = (pnlUsd: number, i: number) => ({
  status: i % 2 ? 'closed' : 'settled',
  pnlUsd,
  openedAmount: 1,
  maxLossUsd: 200,
  lossToCredit: 1.9,
  closedAt: `2026-09-${String(10 + i).padStart(2, '0')}T08:00:00Z`,
}) as unknown as SpreadRecord;

test('deal statistics count only finished deals', () => {
  const spreads = [100, 50, -120, 30, -10].map(deal);
  spreads.push({ status: 'open' } as SpreadRecord, { status: 'cancelled' } as SpreadRecord);
  const d = dealStats(spreads);
  assert.equal(d.deals, 5);
  assert.equal(d.wins, 3);
  assert.equal(d.losses, 2);
  assert.equal(d.winRatePct, 60);
  assert.equal(d.netPnlUsd, 50);
  assert.equal(d.profitFactor, 180 / 130);
  assert.equal(d.avgWinUsd, 60);
  assert.equal(d.avgLossUsd, 65);
  assert.equal(d.realizedRiskToReward, 65 / 60);
  assert.equal(d.expectancyUsd, 10);
  assert.ok(Math.abs(d.avgR - 0.05) < 1e-12);
  assert.equal(d.largestWinUsd, 100);
  assert.equal(d.largestLossUsd, -120);
  assert.equal(d.maxConsecutiveLosses, 1);
  assert.equal(d.plannedRiskToReward, 1.9);
});

test('ratios use strategy P&L, so a swinging coin price does not count as strategy risk', () => {
  const steps = [10, 12, 8, 11, 9, -5, 10, 12, 9];
  const samples: EquitySample[] = [];
  let strategy = 0;
  for (let day = 0; day <= steps.length; day++) {
    if (day > 0) strategy += steps[day - 1];
    // Account equity jumps around with the coin; the strategy line only moves by its own P&L.
    samples.push({ t: Date.UTC(2026, 8, 1 + day, 23), equityUsd: 10_000 * (1 + 0.05 * Math.sin(day)), strategyUsd: strategy });
  }
  const e = equityStats(samples);
  assert.equal(e.days, 10);
  assert.equal(e.dailyReturns, 9);
  assert.ok(e.sharpe > 0 && e.sortino > e.sharpe, `sharpe ${e.sharpe} sortino ${e.sortino}`);
  assert.equal(e.maxDrawdownUsd, 5);
});

test('equity statistics need at least two samples', () => {
  const e = equityStats([{ t: 1, equityUsd: 100, strategyUsd: 0 }]);
  assert.ok(Number.isNaN(e.sharpe));
  assert.equal(e.days, 1);
});

test('downsampling keeps the first and last samples and respects the cap', () => {
  const s = Array.from({ length: 5000 }, (_, i) => ({ t: i, equityUsd: i, strategyUsd: 0 }));
  const d = downsample(s, 600);
  assert.ok(d.length <= 601);
  assert.equal(d[0], s[0]);
  assert.equal(d.at(-1), s.at(-1));
});
