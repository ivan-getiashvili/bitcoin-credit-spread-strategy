/**
 * The running equity summary must give exactly the statistics the full sample history
 * gives, because on Cloudflare the history is never read back.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSample, equityStatsFromAgg, type EquityAgg, type EquitySample } from '../lib/metrics.ts';

/** The original, whole-history implementation, kept here as the reference. */
function referenceStats(samples: EquitySample[]) {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  const byDay = new Map<string, EquitySample>();
  for (const s of samples) byDay.set(dayOf(s.t), s);
  const days = [...byDay.values()];
  const returns: number[] = [];
  for (let i = 1; i < days.length; i++) {
    if (days[i - 1].equityUsd > 0) returns.push((days[i].strategyUsd - days[i - 1].strategyUsd) / days[i - 1].equityUsd);
  }
  const avg = mean(returns);
  const sd = returns.length > 1 ? Math.sqrt(sum(returns.map((r) => (r - avg) ** 2)) / (returns.length - 1)) : NaN;
  const downside = returns.length ? Math.sqrt(sum(returns.map((r) => Math.min(r, 0) ** 2)) / returns.length) : NaN;
  const first = samples[0];
  let peak = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  let curve = 0;
  for (const s of samples) {
    curve = first.equityUsd + s.strategyUsd - first.strategyUsd;
    peak = Math.max(peak, curve);
    maxDd = Math.max(maxDd, peak - curve);
    if (peak > 0) maxDdPct = Math.max(maxDdPct, ((peak - curve) / peak) * 100);
  }
  const last = samples[samples.length - 1];
  return {
    days: days.length,
    dailyReturns: returns.length,
    sharpe: sd > 0 ? (avg / sd) * Math.sqrt(365) : NaN,
    sortino: downside > 0 ? (avg / downside) * Math.sqrt(365) : NaN,
    maxDrawdownUsd: maxDd,
    maxDrawdownPct: maxDdPct,
    currentDrawdownUsd: peak - curve,
    strategyReturnPct: ((last.strategyUsd - first.strategyUsd) / first.equityUsd) * 100,
    accountChangeUsd: last.equityUsd - first.equityUsd,
    accountChangePct: (last.equityUsd / first.equityUsd - 1) * 100,
    since: first.t,
  };
}

/** A deterministic random walk: 30 days of 10-minute samples. */
function walk(count: number, seed = 7): EquitySample[] {
  let x = seed;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5;
  const out: EquitySample[] = [];
  let pnl = 0;
  for (let i = 0; i < count; i++) {
    pnl += rand() * 400;
    out.push({ t: Date.UTC(2026, 8, 1) + i * 10 * 60_000, equityUsd: 100_000 + pnl, strategyUsd: pnl });
  }
  return out;
}

function assertClose(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [k, v] of Object.entries(expected)) {
    const a = actual[k];
    if (typeof v === 'number' && Number.isNaN(v)) assert.ok(Number.isNaN(a), `${k}: expected NaN, got ${a}`);
    else if (typeof v === 'number') assert.ok(Math.abs((a as number) - v) <= 1e-9 * Math.max(1, Math.abs(v)), `${k}: expected ${v}, got ${a}`);
    else assert.equal(a, v, k);
  }
}

test('running equity summary matches statistics over the whole history', () => {
  const samples = walk(30 * 144);
  let agg: EquityAgg | undefined;
  for (const s of samples) agg = addSample(agg, s);
  assertClose(equityStatsFromAgg(agg), referenceStats(samples));
});

test('equity summary survives being saved and reloaded between samples', () => {
  const samples = walk(5 * 144, 11);
  let agg: EquityAgg | undefined;
  for (const s of samples) agg = JSON.parse(JSON.stringify(addSample(agg, s)));
  assertClose(equityStatsFromAgg(agg), referenceStats(samples));
});

test('chart series stays bounded and keeps the first and latest samples', () => {
  const samples = walk(5000, 3);
  let agg: EquityAgg | undefined;
  for (const s of samples) agg = addSample(agg, s);
  assert.ok(agg!.series.length <= 1201, `series has ${agg!.series.length} points`);
  assert.equal(agg!.series[0].t, samples[0].t);
  assert.equal(agg!.series.at(-1)!.t, samples.at(-1)!.t);
});

test('fewer than two samples gives empty statistics', () => {
  assert.equal(equityStatsFromAgg(undefined).days, 0);
  const one = addSample(undefined, { t: 1, equityUsd: 100_000, strategyUsd: 0 });
  assert.equal(equityStatsFromAgg(one).days, 1);
  assert.ok(Number.isNaN(equityStatsFromAgg(one).sharpe));
});
