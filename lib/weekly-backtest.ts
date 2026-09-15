/**
 * The weekly strategy on cached history (data/history-tapes, from `npm run history:tapes`),
 * priced the way scripts/structure-search.ts prices it: real trades from the entry morning
 * moved to the entry moment, untraded legs by Black-76 at the nearest traded strike's
 * volatility, Deribit fees on every leg, delivery fees on Friday expiries. Used to seed the
 * dashboard with the weeks before launch (scripts/seed.ts).
 */
import { readFileSync } from 'node:fs';
import { callPrice, putPrice } from './blackscholes.ts';
import type { OptionType } from './executor.ts';
import type { TapeTrade } from './history.ts';
import { MARKETS, type MarketId } from './markets.ts';
import { FEES, takerFee } from './spread.ts';

const DAY = 86_400_000;
const YEAR = 365 * DAY;
const MIN_PRICE: Record<string, number> = { BTC: 5, ETH: 0.5, SOL: 0.1 };
const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isFriday = (date: string) => new Date(`${date}T08:00:00Z`).getUTCDay() === 5;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const deliveryFee = (expiry: string, intrinsic: number, settle: number) =>
  intrinsic > 0 && isFriday(expiry) ? Math.min(FEES.delivery * settle, FEES.capShare * intrinsic) : 0;

type Quote = { strike: number; mid: number; bid?: number; ask?: number; iv: number };

function quotes(tape: TapeTrade[], expiryMs: number, entryMs: number, spot: number, type: OptionType, inverse: boolean): Map<number, Quote> {
  const model = type === 'put' ? putPrice : callPrice;
  const t0 = (expiryMs - entryMs) / YEAR;
  const by = new Map<number, { mid: number[]; sell: number[]; buy: number[]; iv: number[] }>();
  for (const x of tape) {
    if (x.expiryMs !== expiryMs || (x.type ?? 'put') !== type || !(x.iv > 0) || !(x.mark > 0) || !(x.index > 0)) continue;
    const vol = x.iv / 100;
    const markUsd = inverse ? x.mark * x.index : x.mark;
    const mid = markUsd + model(spot, x.strike, t0, vol) - model(x.index, x.strike, (expiryMs - x.t) / YEAR, vol);
    if (!(mid > 0)) continue;
    let s = by.get(x.strike);
    if (!s) by.set(x.strike, (s = { mid: [], sell: [], buy: [], iv: [] }));
    s.mid.push(mid);
    (x.side === 'sell' ? s.sell : s.buy).push(x.price / x.mark - 1);
    s.iv.push(vol);
  }
  const out = new Map<number, Quote>();
  for (const [strike, s] of by) {
    const mid = median(s.mid);
    out.set(strike, { strike, mid, bid: s.sell.length ? mid * (1 + Math.min(0, median(s.sell))) : undefined, ask: s.buy.length ? mid * (1 + Math.max(0, median(s.buy))) : undefined, iv: median(s.iv) });
  }
  return out;
}

export type WeeklyTrade = {
  entry: string;
  expiry: string;
  spot: number;
  settle: number;
  shortStrike: number;
  longStrike: number;
  /** Per unit of underlying, dollars, after fees. */
  creditUsd: number;
  maxLossUsd: number;
  pnlUsd: number;
  modelled: boolean;
};

export type WeeklyConfig = { type: OptionType; distanceAtr: number; atrDays: number; longSteps: number; fill: 'mid' | 'cross' };

/** Every Friday entry from `from` to `to` (settlement days) for one coin and configuration. */
export function simulateWeekly(id: MarketId, cfg: WeeklyConfig, from: string, to: string): WeeklyTrade[] {
  const market = MARKETS[id];
  const inverse = market.settlement === 'inverse';
  const dir = `data/history-tapes/${id}`;
  const delivery: Record<string, number> = JSON.parse(readFileSync(`${dir}/delivery.json`, 'utf8'));
  const dates = Object.keys(delivery).sort();
  const trades: WeeklyTrade[] = [];
  for (let i = cfg.atrDays; i < dates.length; i++) {
    const date = dates[i];
    if (!isFriday(date)) continue;
    const expiryMs = Date.parse(`${date}T08:00:00Z`) + 7 * DAY;
    const expiry = iso(expiryMs);
    if (expiry < from || expiry > to) continue;
    const spot = delivery[date];
    const settle = delivery[expiry];
    if (!spot || !settle) continue;
    let tape: TapeTrade[];
    try { tape = JSON.parse(readFileSync(`${dir}/${date}.json`, 'utf8')); } catch { continue; }
    const moves: number[] = [];
    for (let j = i - cfg.atrDays + 1; j <= i; j++) moves.push(Math.abs(delivery[dates[j]] / delivery[dates[j - 1]] - 1));
    const atrH = (sum(moves) / moves.length) * Math.sqrt(7);
    const entryMs = Date.parse(`${date}T08:05:00Z`);
    const book = quotes(tape, expiryMs, entryMs, spot, cfg.type, inverse);
    const strikes = [...book.keys()].filter((k) => Math.abs(k / spot - 1) < 0.1).sort((a, b) => a - b);
    let step = Infinity;
    for (let k = 1; k < strikes.length; k++) step = Math.min(step, strikes[k] - strikes[k - 1]);
    if (!Number.isFinite(step)) continue;
    const dist = cfg.distanceAtr * atrH;
    const shortStrike = cfg.type === 'put' ? Math.floor((spot * (1 - dist)) / step) * step : Math.ceil((spot * (1 + dist)) / step) * step;
    if (cfg.type === 'put' ? shortStrike >= spot : shortStrike <= spot) continue;
    const longStrike = cfg.type === 'put' ? shortStrike - cfg.longSteps * step : shortStrike + cfg.longSteps * step;
    const t0 = (expiryMs - entryMs) / YEAR;
    const price = (strike: number, side: 'sell' | 'buy'): { p: number; real: boolean } | null => {
      const q = book.get(strike);
      if (q && (cfg.fill === 'mid' || (side === 'sell' ? q.bid : q.ask) !== undefined)) return { p: cfg.fill === 'mid' ? q.mid : side === 'sell' ? q.bid! : q.ask!, real: true };
      const near = [...book.values()];
      if (!near.length) return null;
      const ref = near.reduce((a, b) => (Math.abs(b.strike - strike) < Math.abs(a.strike - strike) ? b : a));
      const m = Math.max((cfg.type === 'put' ? putPrice : callPrice)(spot, strike, t0, ref.iv), MIN_PRICE[id]);
      return { p: cfg.fill === 'mid' ? m : side === 'sell' ? m - MIN_PRICE[id] : m + MIN_PRICE[id], real: false };
    };
    const s = price(shortStrike, 'sell');
    const l = price(longStrike, 'buy');
    if (!s || !l) continue;
    const fee = takerFee(s.p, spot) + takerFee(l.p, spot);
    const creditUsd = s.p - l.p - fee;
    const width = Math.abs(shortStrike - longStrike);
    const maxLossUsd = width - creditUsd;
    if (!(creditUsd > 0) || !(maxLossUsd > 0) || creditUsd > 0.6 * width) continue;
    const si = cfg.type === 'put' ? Math.max(shortStrike - settle, 0) : Math.max(settle - shortStrike, 0);
    const li = cfg.type === 'put' ? Math.max(longStrike - settle, 0) : Math.max(settle - longStrike, 0);
    const pnlUsd = creditUsd - si + li - deliveryFee(expiry, si, settle) - deliveryFee(expiry, li, settle);
    trades.push({ entry: date, expiry, spot, settle, shortStrike, longStrike, creditUsd, maxLossUsd, pnlUsd, modelled: !s.real || !l.real });
  }
  return trades;
}
