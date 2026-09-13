/**
 * Bull put spread backtest, filled the way Ivan trades: market orders, the long
 * (lower) put bought at the ask first, then the short (higher) put sold at the bid.
 *
 * Prices come from Deribit's tape (lib/history.ts). Every trade records Deribit's
 * mark at that instant and which side the taker was on, so each trade tells us two
 * things: the fair price, and how far from it a market order had to go — below it
 * when selling into the bid, above it when buying from the ask. Measuring that
 * distance trade by trade, against the mark of the same moment, keeps the bid below
 * the ask even when volatility drifts during the entry window.
 *
 * Trades happen at slightly different moments, so each mark is moved to the entry
 * instant with Black-76: the real mark plus the model's estimate of how far the
 * option moved in between. The model nudges a real price; it never invents one.
 *
 * Strikes are chosen by `pickSpread` in lib/spread.ts, the same rule the bot uses.
 */
import { bs, putPrice } from './blackscholes.ts';
import { ENTRY_HOUR_UTC, type TapeTrade } from './history.ts';
import type { Market } from './markets.ts';
import { pickSpread, pnlAtExpiry, type Quote, type SpreadRule } from './spread.ts';

const DAY = 86_400_000;
const years = (ms: number) => ms / DAY / 365;

export type Config = SpreadRule & {
  /** Target days to expiry. */
  dte: number;
};

/**
 * sma50: price above its 50-day average on the entry morning — knowable at the time.
 * quarter: calendar quarter that did not fall more than 10% — chosen with hindsight.
 */
export type Regime = 'sma50' | 'quarter';

export type Trade = {
  entry: string;
  expiry: string;
  dte: number;
  spot: number;
  shortStrike: number;
  longStrike: number;
  /** How far below spot the short strike sits, percent. */
  distancePct: number;
  widthPct: number;
  shortDelta: number;
  /** After taker fees, in dollars at entry. */
  creditUsd: number;
  maxLossUsd: number;
  lossToCredit: number;
  /** Share of the mid-price credit lost to crossing both spreads and paying fees. */
  frictionPct: number;
  /** The market's own odds of finishing above breakeven, from the short put's IV. */
  impliedWinPct: number;
  settle: number;
  pnlUsd: number;
  /** P&L as a multiple of the maximum loss: -1 is a full loss. */
  r: number;
  win: boolean;
};

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** What a market order would have got, per strike, for one expiry at the entry instant. */
export function quotesAtEntry(tape: TapeTrade[], expiryMs: number, entryMs: number, spot: number, market: Market): Quote[] {
  const t0 = years(expiryMs - entryMs);
  const byStrike = new Map<number, { mid: number[]; sellEdge: number[]; buyEdge: number[]; iv: number[] }>();
  for (const x of tape) {
    if (x.expiryMs !== expiryMs || !(x.iv > 0) || !(x.price > 0) || !(x.mark > 0) || !(x.index > 0)) continue;
    const vol = x.iv / 100;
    const markUsd = market.settlement === 'inverse' ? x.mark * x.index : x.mark;
    const moved = putPrice(spot, x.strike, t0, vol) - putPrice(x.index, x.strike, years(expiryMs - x.t), vol);
    const mid = markUsd + moved;
    if (!(mid > 0)) continue;
    let s = byStrike.get(x.strike);
    if (!s) byStrike.set(x.strike, (s = { mid: [], sellEdge: [], buyEdge: [], iv: [] }));
    s.mid.push(mid);
    // How far from the mark the taker traded: below it hitting the bid, above it lifting the ask.
    (x.side === 'sell' ? s.sellEdge : s.buyEdge).push(x.price / x.mark - 1);
    s.iv.push(vol);
  }
  return [...byStrike].map(([strike, s]) => {
    const mid = median(s.mid);
    // A market order never does better than fair: the bid is capped at the mid
    // and the ask floored at it, so noisy prints cannot manufacture an edge.
    return {
      strike,
      mid,
      bid: s.sellEdge.length ? mid * (1 + Math.min(0, median(s.sellEdge))) : undefined,
      ask: s.buyEdge.length ? mid * (1 + Math.max(0, median(s.buyEdge))) : undefined,
      iv: median(s.iv),
    };
  });
}

export function regimeDates(regime: Regime, delivery: Record<string, number>): Set<string> {
  const dates = Object.keys(delivery).sort();
  const ok = new Set<string>();
  if (regime === 'sma50') {
    let sum = 0;
    for (let i = 0; i < dates.length; i++) {
      sum += delivery[dates[i]];
      if (i >= 50) sum -= delivery[dates[i - 50]];
      if (i >= 49 && delivery[dates[i]] > sum / 50) ok.add(dates[i]);
    }
    return ok;
  }
  const quarters = new Map<string, string[]>();
  for (const d of dates) {
    const q = `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
    if (!quarters.has(q)) quarters.set(q, []);
    quarters.get(q)!.push(d);
  }
  for (const ds of quarters.values()) {
    if (delivery[ds[ds.length - 1]] / delivery[ds[0]] - 1 > -0.1) for (const d of ds) ok.add(d);
  }
  return ok;
}

export function runBacktest(
  market: Market,
  delivery: Record<string, number>,
  tapes: Map<string, TapeTrade[]>,
  cfg: Config,
  allowed: Set<string>,
) {
  const counts = { entries: 0, offRegime: 0, noData: 0, noQuotes: 0, ruleNotMet: 0, unsettled: 0 };
  const trades: Trade[] = [];
  const entryDates = [...tapes.keys()].sort();

  for (const date of entryDates) {
    counts.entries++;
    const spot = delivery[date];
    const tape = tapes.get(date)!;
    if (!spot || !tape.length) { counts.noData++; continue; }
    if (!allowed.has(date)) { counts.offRegime++; continue; }

    const entryMs = Date.parse(`${date}T${String(ENTRY_HOUR_UTC).padStart(2, '0')}:00:00Z`);
    const tolerance = Math.max(2, cfg.dte * 0.25);
    let expiryMs = 0;
    for (const e of new Set(tape.map((x) => x.expiryMs))) {
      const off = Math.abs((e - entryMs) / DAY - cfg.dte);
      if (off > tolerance) continue;
      if (!expiryMs || off < Math.abs((expiryMs - entryMs) / DAY - cfg.dte)) expiryMs = e;
    }
    if (!expiryMs) { counts.noData++; continue; }
    const expiry = new Date(expiryMs).toISOString().slice(0, 10);
    const settle = delivery[expiry];
    if (!settle) { counts.unsettled++; continue; }

    const t = years(expiryMs - entryMs);
    const quotes = quotesAtEntry(tape, expiryMs, entryMs, spot, market);
    const pick = pickSpread(quotes, spot, market, cfg);
    if (!pick) {
      // Separate "the market offered nothing that pays 1:2" from "nothing traded".
      if (pickSpread(quotes, spot, market, { ...cfg, maxLossToCredit: Infinity })) counts.ruleNotMet++;
      else counts.noQuotes++;
      continue;
    }

    const { short, long, creditUsd, maxLossUsd, midCreditUsd, widthUsd } = pick;
    const g = bs(spot, short.strike, t, short.iv, 'put');
    const be = bs(spot, short.strike - creditUsd, t, short.iv, 'put');
    const pnlUsd = pnlAtExpiry(market, creditUsd, spot, short.strike, long.strike, settle);
    trades.push({
      entry: date,
      expiry,
      dte: t * 365,
      spot,
      shortStrike: short.strike,
      longStrike: long.strike,
      distancePct: (1 - short.strike / spot) * 100,
      widthPct: (widthUsd / spot) * 100,
      shortDelta: g ? -g.putDelta : NaN,
      creditUsd,
      maxLossUsd,
      lossToCredit: maxLossUsd / creditUsd,
      frictionPct: (1 - creditUsd / midCreditUsd) * 100,
      impliedWinPct: be ? (1 - be.probItm) * 100 : NaN,
      settle,
      pnlUsd,
      r: pnlUsd / maxLossUsd,
      win: pnlUsd > 0,
    });
  }

  const span = entryDates.length > 1 ? years(Date.parse(entryDates.at(-1)!) - Date.parse(entryDates[0])) : 0;
  return { counts, trades, years: span };
}

export function summarize(trades: Trade[], cfg: Config, spanYears: number) {
  const n = trades.length;
  if (!n) return { n };
  let cum = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of trades) {
    cum += t.r;
    peak = Math.max(peak, cum);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cum);
  }
  return {
    n,
    winPct: (100 * trades.filter((t) => t.win).length) / n,
    impliedWinPct: median(trades.map((t) => t.impliedWinPct)),
    avgR: cum / n,
    totalR: cum,
    worstR: Math.min(...trades.map((t) => t.r)),
    maxDrawdownR,
    // Capital is one max loss per open position. Entering weekly, a 28-day spread
    // has about four open at once, so it ties up four times the capital.
    annualReturnPct: spanYears > 0 ? (100 * cum) / spanYears / Math.max(1, cfg.dte / 7) : NaN,
    distancePct: median(trades.map((t) => t.distancePct)),
    shortDelta: median(trades.map((t) => t.shortDelta)),
    lossToCredit: median(trades.map((t) => t.lossToCredit)),
    frictionPct: median(trades.map((t) => t.frictionPct)),
  };
}
