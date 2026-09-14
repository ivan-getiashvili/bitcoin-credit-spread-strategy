/**
 * Performance statistics for the dashboard.
 *
 * Deal statistics come from finished spreads (closed or settled). Percentages per
 * deal are measured against the account value when that deal started. Ratio and
 * drawdown statistics come from the equity samples, using the STRATEGY's P&L: an
 * exchange account holding coins gains and loses dollars whenever those coins move,
 * and a Sharpe ratio of that would measure the coin, not the strategy. Daily returns
 * are the day's change in strategy P&L divided by the account value at the start
 * of that day.
 */
import type { SpreadRecord } from './executor.ts';

/** One reading of the account, in dollars. */
export type EquitySample = { t: number; equityUsd: number; strategyUsd: number };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);

export function dealStats(spreads: SpreadRecord[]) {
  const deals = spreads.filter((s) => (s.status === 'closed' || s.status === 'settled') && Number.isFinite(s.pnlUsd));
  const pnls = deals.map((d) => d.pnlUsd!);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = sum(wins);
  const grossLoss = -sum(losses);
  const avgWin = wins.length ? grossProfit / wins.length : NaN;
  const avgLoss = losses.length ? grossLoss / losses.length : NaN;
  const onRisk = deals.filter((d) => d.openedAmount > 0 && d.maxLossUsd > 0).map((d) => d.pnlUsd! / (d.openedAmount * d.maxLossUsd));
  const onAccount = deals.filter((d) => d.accountUsdAtEntry > 0).map((d) => (100 * d.pnlUsd!) / d.accountUsdAtEntry);
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
    /** Average P&L per deal as % of the account value at entry. */
    avgGainPct: mean(onAccount),
    avgWinPct: mean(onAccount.filter((x) => x > 0)),
    avgLossPct: mean(onAccount.filter((x) => x < 0)),
    bestDealPct: onAccount.length ? Math.max(...onAccount) : NaN,
    worstDealPct: onAccount.length ? Math.min(...onAccount) : NaN,
    /** Average loss per average win, measured on real deals. */
    realizedRiskToReward: avgLoss / avgWin,
    /** Average of max loss divided by credit, as filled when each spread opened. */
    plannedRiskToReward: planned.length ? sum(planned) / planned.length : NaN,
    expectancyUsd: deals.length ? sum(pnls) / deals.length : NaN,
    /** Average P&L as a share of each deal's maximum loss. */
    avgR: mean(onRisk),
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

/**
 * Everything the equity statistics and the chart need, updated one sample at a time, so
 * the full sample history never has to be read back. The bot keeps this in its state.
 */
export type EquityAgg = {
  count: number;
  first: EquitySample;
  last: EquitySample;
  /** Highest point so far of the strategy curve: starting value plus strategy P&L. */
  peak: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  /** The last sample of each UTC day. */
  closes: EquitySample[];
  /** Every sample, thinned by half whenever it outgrows SERIES_KEEP, for the chart. */
  series: EquitySample[];
};

const SERIES_KEEP = 1200;

export function addSample(agg: EquityAgg | undefined, s: EquitySample): EquityAgg {
  const a: EquityAgg = agg ?? { count: 0, first: s, last: s, peak: -Infinity, maxDrawdownUsd: 0, maxDrawdownPct: 0, closes: [], series: [] };
  a.count += 1;
  a.last = s;

  // Drawdown on the strategy curve: starting value plus strategy P&L.
  const curve = a.first.equityUsd + s.strategyUsd - a.first.strategyUsd;
  a.peak = Math.max(a.peak, curve);
  a.maxDrawdownUsd = Math.max(a.maxDrawdownUsd, a.peak - curve);
  if (a.peak > 0) a.maxDrawdownPct = Math.max(a.maxDrawdownPct, ((a.peak - curve) / a.peak) * 100);

  const close = a.closes[a.closes.length - 1];
  if (close && dayOf(close.t) === dayOf(s.t)) a.closes[a.closes.length - 1] = s;
  else a.closes.push(s);

  a.series.push(s);
  if (a.series.length > SERIES_KEEP) {
    a.series = a.series.filter((_, i) => i % 2 === 0);
    if (a.series[a.series.length - 1] !== s) a.series.push(s);
  }
  return a;
}

export function equityStatsFromAgg(a: EquityAgg | undefined) {
  const empty = { days: 0, dailyReturns: 0, sharpe: NaN, sortino: NaN, maxDrawdownUsd: NaN, maxDrawdownPct: NaN, currentDrawdownUsd: NaN, strategyReturnPct: NaN, accountChangeUsd: NaN, accountChangePct: NaN, since: null as number | null };
  if (!a || a.count < 2) return { ...empty, days: a ? 1 : 0, since: a?.first.t ?? null };

  const days = a.closes;
  const returns: number[] = [];
  for (let i = 1; i < days.length; i++) {
    if (days[i - 1].equityUsd > 0) returns.push((days[i].strategyUsd - days[i - 1].strategyUsd) / days[i - 1].equityUsd);
  }
  const avg = mean(returns);
  const sd = returns.length > 1 ? Math.sqrt(sum(returns.map((r) => (r - avg) ** 2)) / (returns.length - 1)) : NaN;
  const downside = returns.length ? Math.sqrt(sum(returns.map((r) => Math.min(r, 0) ** 2)) / returns.length) : NaN;

  const { first, last } = a;
  const curve = first.equityUsd + last.strategyUsd - first.strategyUsd;
  return {
    days: days.length,
    dailyReturns: returns.length,
    /** Annualised over 365 days, zero risk-free rate. */
    sharpe: sd > 0 ? (avg / sd) * Math.sqrt(365) : NaN,
    /** Like Sharpe, but only losing days count as risk. */
    sortino: downside > 0 ? (avg / downside) * Math.sqrt(365) : NaN,
    maxDrawdownUsd: a.maxDrawdownUsd,
    maxDrawdownPct: a.maxDrawdownPct,
    currentDrawdownUsd: a.peak - curve,
    strategyReturnPct: first.equityUsd > 0 ? ((last.strategyUsd - first.strategyUsd) / first.equityUsd) * 100 : NaN,
    accountChangeUsd: last.equityUsd - first.equityUsd,
    accountChangePct: first.equityUsd > 0 ? (last.equityUsd / first.equityUsd - 1) * 100 : NaN,
    since: first.t,
  };
}

export function equityStats(samples: EquitySample[]) {
  let agg: EquityAgg | undefined;
  for (const s of samples) agg = addSample(agg, s);
  return equityStatsFromAgg(agg);
}

/** At most `max` points for the chart, keeping the first and last samples. */
export function downsample(samples: EquitySample[], max = 600): EquitySample[] {
  if (samples.length <= max) return samples;
  const stride = Math.ceil(samples.length / (max - 1));
  const out = samples.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== samples[samples.length - 1]) out.push(samples[samples.length - 1]);
  return out;
}
