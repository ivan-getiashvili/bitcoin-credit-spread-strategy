/**
 * Performance statistics for the dashboard.
 *
 * Deal statistics come from finished spreads (closed or settled). Ratio and
 * drawdown statistics come from the equity samples, using the STRATEGY's P&L
 * rather than raw account equity: an account holding BTC as collateral gains and
 * loses dollars whenever BTC moves, and a Sharpe ratio of that would measure BTC,
 * not the strategy. Daily returns are the day's change in strategy P&L divided by
 * the account's equity at the start of that day.
 */
import type { SpreadRecord } from './executor.ts';

/** One reading of the account, in dollars. */
export type EquitySample = { t: number; equityUsd: number; strategyUsd: number };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function dealStats(spreads: SpreadRecord[]) {
  const deals = spreads.filter((s) => (s.status === 'closed' || s.status === 'settled') && Number.isFinite(s.pnlUsd));
  const pnls = deals.map((d) => d.pnlUsd!);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = sum(wins);
  const grossLoss = -sum(losses);
  const avgWin = wins.length ? grossProfit / wins.length : NaN;
  const avgLoss = losses.length ? grossLoss / losses.length : NaN;
  const rs = deals.filter((d) => d.openedAmount > 0 && d.maxLossUsd > 0).map((d) => d.pnlUsd! / (d.openedAmount * d.maxLossUsd));
  const planned = deals.map((d) => d.lossToCredit).filter((x) => Number.isFinite(x) && x > 0);

  let run = 0;
  let maxConsecutiveLosses = 0;
  for (const d of [...deals].sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''))) {
    run = d.pnlUsd! < 0 ? run + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, run);
  }

  return {
    deals: deals.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: deals.length ? (100 * wins.length) / deals.length : NaN,
    netPnlUsd: sum(pnls),
    grossProfitUsd: grossProfit,
    grossLossUsd: grossLoss,
    /** Gross profit divided by gross loss. Infinite with profits and no losses yet. */
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : NaN,
    avgWinUsd: avgWin,
    avgLossUsd: avgLoss,
    /** Average loss per average win: Ivan's risk-to-reward, measured on real deals (target at most 2). */
    realizedRiskToReward: avgLoss / avgWin,
    /** Average of max loss divided by credit, as planned when each spread opened. */
    plannedRiskToReward: planned.length ? sum(planned) / planned.length : NaN,
    expectancyUsd: deals.length ? sum(pnls) / deals.length : NaN,
    /** Average P&L as a share of each deal's maximum loss. */
    avgR: rs.length ? sum(rs) / rs.length : NaN,
    largestWinUsd: wins.length ? Math.max(...wins) : NaN,
    largestLossUsd: losses.length ? Math.min(...losses) : NaN,
    maxConsecutiveLosses,
  };
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The last sample of each UTC day. */
export function dailyCloses(samples: EquitySample[]): EquitySample[] {
  const byDay = new Map<string, EquitySample>();
  for (const s of samples) byDay.set(dayOf(s.t), s);
  return [...byDay.values()];
}

export function equityStats(samples: EquitySample[]) {
  const empty = { days: 0, dailyReturns: 0, sharpe: NaN, sortino: NaN, maxDrawdownUsd: NaN, maxDrawdownPct: NaN, currentDrawdownUsd: NaN, strategyReturnPct: NaN, accountChangeUsd: NaN, accountChangePct: NaN, since: null as number | null };
  if (samples.length < 2) return { ...empty, days: samples.length ? 1 : 0, since: samples[0]?.t ?? null };

  const days = dailyCloses(samples);
  const returns: number[] = [];
  for (let i = 1; i < days.length; i++) {
    if (days[i - 1].equityUsd > 0) returns.push((days[i].strategyUsd - days[i - 1].strategyUsd) / days[i - 1].equityUsd);
  }
  const mean = returns.length ? sum(returns) / returns.length : NaN;
  const sd = returns.length > 1 ? Math.sqrt(sum(returns.map((r) => (r - mean) ** 2)) / (returns.length - 1)) : NaN;
  const downside = returns.length ? Math.sqrt(sum(returns.map((r) => Math.min(r, 0) ** 2)) / returns.length) : NaN;

  // Drawdown on the strategy curve: starting equity plus strategy P&L.
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
    /** Annualised over 365 days, zero risk-free rate. */
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : NaN,
    /** Like Sharpe, but only losing days count as risk. */
    sortino: downside > 0 ? (mean / downside) * Math.sqrt(365) : NaN,
    maxDrawdownUsd: maxDd,
    maxDrawdownPct: maxDdPct,
    currentDrawdownUsd: peak - curve,
    strategyReturnPct: first.equityUsd > 0 ? ((last.strategyUsd - first.strategyUsd) / first.equityUsd) * 100 : NaN,
    accountChangeUsd: last.equityUsd - first.equityUsd,
    accountChangePct: first.equityUsd > 0 ? (last.equityUsd / first.equityUsd - 1) * 100 : NaN,
    since: first.t,
  };
}

/** At most `max` points for the chart, keeping the first and last samples. */
export function downsample(samples: EquitySample[], max = 600): EquitySample[] {
  if (samples.length <= max) return samples;
  const stride = Math.ceil(samples.length / (max - 1));
  const out = samples.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== samples[samples.length - 1]) out.push(samples[samples.length - 1]);
  return out;
}
