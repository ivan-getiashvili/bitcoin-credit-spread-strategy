/**
 * Backtest of the daily put spread, for the grid search.
 *
 * Each morning at the 08:00 UTC settlement: sell the put at the `shortRank`-th strike
 * below the price, buy the put `width` strikes below that, on the expiry `dte` days
 * out, and hold to expiry. Every spread is sized so its maximum loss is `riskPct` of
 * the account, so a result of R (P&L / max loss) moves the account by riskPct x R.
 *
 * Prices come from Deribit's coin-settled tape via `quotesAtEntry` (lib/backtest.ts):
 * each put's mid is the exchange's own mark, moved to the entry instant, and its bid
 * and ask are how far real taker trades landed from that mark. Everything is in
 * dollars, and the payoff is the dollar payoff of the USDC-settled spread the bot
 * trades. Two fill models bracket what limit orders really get:
 *   mid    both legs fill at the mid (the bot's limit price, if it fills at all)
 *   cross  sell at the bid, buy at the ask (what paying the spread costs)
 */
import { quotesAtEntry } from './backtest.ts';
import type { TapeTrade } from './history.ts';
import type { Market } from './markets.ts';
import { FEES, takerFee, type Quote } from './spread.ts';

const DAY = 86_400_000;

export type DailyConfig = {
  /** 1 sells the first strike below the price. */
  shortRank: number;
  /** Strikes between the sold and the bought put. */
  width: number;
  dte: 1 | 2;
  /** none trades every day; sma50 only when the price is above its 50-day average. */
  filter: 'none' | 'sma50';
  fill: 'mid' | 'cross';
};

export type DailyTrade = {
  entry: string;
  expiry: string;
  spot: number;
  settle: number;
  step: number;
  shortStrike: number;
  longStrike: number;
  creditUsd: number;
  maxLossUsd: number;
  pnlUsd: number;
  /** P&L as a multiple of max loss: -1 is a full loss. */
  r: number;
};

/** One morning, priced once and shared by every configuration. */
export type Morning = {
  date: string;
  spot: number;
  expiry: string;
  settle: number;
  /** Distance between listed strikes near the money. */
  step: number;
  quotes: Map<number, Quote>;
};

/**
 * The strike step is the smallest gap between traded strikes near the money. Sparse
 * trading can only make a gap look wider, never narrower, so the minimum is the grid.
 */
function strikeStep(quotes: Quote[], spot: number): number {
  const near = [...new Set(quotes.map((q) => q.strike))].filter((k) => Math.abs(k / spot - 1) <= 0.1).sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < near.length; i++) step = Math.min(step, near[i] - near[i - 1]);
  return near.length >= 3 ? step : NaN;
}

export function prepareMornings(market: Market, delivery: Record<string, number>, tapes: Map<string, TapeTrade[]>, dte: 1 | 2) {
  const mornings: Morning[] = [];
  const skipped = { noSpot: 0, noExpiry: 0, unsettled: 0, noStep: 0 };
  for (const [date, tape] of [...tapes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const spot = delivery[date];
    if (!spot) { skipped.noSpot++; continue; }
    const entryMs = Date.parse(`${date}T08:05:00Z`);
    const expiryMs = Date.parse(`${date}T08:00:00Z`) + dte * DAY;
    if (!tape.some((x) => x.expiryMs === expiryMs)) { skipped.noExpiry++; continue; }
    const expiry = new Date(expiryMs).toISOString().slice(0, 10);
    const settle = delivery[expiry];
    if (!settle) { skipped.unsettled++; continue; }
    const list = quotesAtEntry(tape, expiryMs, entryMs, spot, market);
    const step = strikeStep(list, spot);
    if (!Number.isFinite(step)) { skipped.noStep++; continue; }
    mornings.push({ date, spot, expiry, settle, step, quotes: new Map(list.map((q) => [q.strike, q])) });
  }
  return { mornings, skipped };
}

/** Daily options pay no delivery fee; weekly Friday expiries do. */
const deliveryFee = (expiry: string, intrinsic: number, settle: number) =>
  intrinsic > 0 && new Date(`${expiry}T08:00:00Z`).getUTCDay() === 5 ? Math.min(FEES.delivery * settle, FEES.capShare * intrinsic) : 0;

export function runDaily(mornings: Morning[], cfg: DailyConfig, allowed: Set<string> | null) {
  const trades: DailyTrade[] = [];
  const skipped = { filter: 0, noQuote: 0, noCredit: 0 };
  for (const m of mornings) {
    if (allowed && !allowed.has(m.date)) { skipped.filter++; continue; }
    // The first listed strike strictly below the price, then further down the ladder.
    const first = Math.ceil(m.spot / m.step - 1e-9) * m.step - m.step;
    const shortStrike = first - (cfg.shortRank - 1) * m.step;
    const longStrike = shortStrike - cfg.width * m.step;
    const s = m.quotes.get(shortStrike);
    const l = m.quotes.get(longStrike);
    const sell = cfg.fill === 'mid' ? s?.mid : s?.bid;
    const buy = cfg.fill === 'mid' ? l?.mid : l?.ask;
    if (sell === undefined || buy === undefined) { skipped.noQuote++; continue; }
    const creditUsd = sell - buy - takerFee(sell, m.spot) - takerFee(buy, m.spot);
    const widthUsd = shortStrike - longStrike;
    const maxLossUsd = widthUsd - creditUsd;
    if (!(creditUsd > 0) || !(maxLossUsd > 0)) { skipped.noCredit++; continue; }
    const si = Math.max(shortStrike - m.settle, 0);
    const li = Math.max(longStrike - m.settle, 0);
    const pnlUsd = creditUsd - si + li - deliveryFee(m.expiry, si, m.settle) - deliveryFee(m.expiry, li, m.settle);
    trades.push({ entry: m.date, expiry: m.expiry, spot: m.spot, settle: m.settle, step: m.step, shortStrike, longStrike, creditUsd, maxLossUsd, pnlUsd, r: pnlUsd / maxLossUsd });
  }
  return { trades, skipped };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Results for trades entered between two dates, with each spread risking `riskPct` of the account. */
export function dailyStats(all: DailyTrade[], from: string, to: string, riskPct: number) {
  const trades = all.filter((t) => t.entry >= from && t.entry <= to);
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0);
  const gain = sum(wins.map((t) => t.r));
  const loss = -sum(trades.filter((t) => t.r < 0).map((t) => t.r));

  // One return per calendar day (zero when nothing settles), compounded into an equity curve.
  const byDay = new Map<string, number>();
  for (const t of trades) byDay.set(t.expiry, (byDay.get(t.expiry) ?? 0) + (riskPct / 100) * t.r);
  const daily: number[] = [];
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`) + 2 * DAY; d += DAY) {
    const ret = byDay.get(new Date(d).toISOString().slice(0, 10)) ?? 0;
    daily.push(ret);
    equity *= 1 + ret;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  const mean = sum(daily) / daily.length;
  const sd = Math.sqrt(sum(daily.map((x) => (x - mean) ** 2)) / Math.max(daily.length - 1, 1));
  const down = Math.sqrt(sum(daily.map((x) => Math.min(x, 0) ** 2)) / daily.length);
  const years = daily.length / 365;
  return {
    trades: n,
    winPct: n ? (100 * wins.length) / n : NaN,
    avgR: n ? sum(trades.map((t) => t.r)) / n : NaN,
    /** Average P&L per deal as % of the account. */
    avgGainPct: n ? (riskPct * sum(trades.map((t) => t.r))) / n : NaN,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : NaN,
    totalReturnPct: (equity - 1) * 100,
    annualReturnPct: equity > 0 ? (equity ** (1 / years) - 1) * 100 : -100,
    maxDrawdownPct: maxDd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : NaN,
    sortino: down > 0 ? (mean / down) * Math.sqrt(365) : NaN,
    worstR: n ? Math.min(...trades.map((t) => t.r)) : NaN,
    medianLossToCredit: n ? [...trades.map((t) => t.maxLossUsd / t.creditUsd)].sort((a, b) => a - b)[n >> 1] : NaN,
  };
}
