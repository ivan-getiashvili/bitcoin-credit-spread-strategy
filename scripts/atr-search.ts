/**
 * Ivan's question (2026-09-15): can the strikes be chosen from each coin's recent daily
 * range instead of "first and second strike below the price"?
 *
 *   npm run atr -- [--coins BTC,ETH] [--atrDays 14]
 *
 * Two parts, on every cached morning (npm run history:daily first):
 *
 * 1. How often does the settlement price fall more than k × ATR in one day? ATR here is the
 *    mean absolute settlement-to-settlement move over the previous `atrDays` days, as a
 *    percentage. A put sold k × ATR below the price is breached on exactly those days.
 *
 * 2. Spreads placed by ATR distance: the sold put at the highest listed strike at least
 *    kShort × ATR below the price, the bought put either `width` strikes lower or a further
 *    kLong × ATR lower. Priced at mids where the strike traded that morning, otherwise
 *    Black-76 at the volatility of the nearest traded strike (far puts trade rarely; flat
 *    volatility flatters them a little). Sized at 1% risk with 5% slack, Deribit fees,
 *    delivery fee on Friday expiries. Chosen in-sample (to 2025-12-31), judged on 2026.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { putPrice } from '../lib/blackscholes.ts';
import { dailyStats, prepareMornings, type DailyTrade, type Morning } from '../lib/daily-backtest.ts';
import type { TapeTrade } from '../lib/history.ts';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { FEES, takerFee } from '../lib/spread.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const coins = arg('coins', 'BTC,ETH').split(',') as MarketId[];
const ATR_DAYS = Number(arg('atrDays', '14'));
const DAY = 86_400_000;
const YEAR_MS = 365 * DAY;
const IS_END = '2025-12-31';
const OOS = ['2026-01-01', '2026-12-31'] as const;
const ALL = ['2024-03-08', '2026-12-31'] as const;
const K_SHORT = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const LONGS: { label: string; steps?: number; kLong?: number }[] = [
  { label: '1 strike', steps: 1 }, { label: '2 strikes', steps: 2 }, { label: '3 strikes', steps: 3 },
  { label: '+0.5 ATR', kLong: 0.5 }, { label: '+1 ATR', kLong: 1 }, { label: '+2 ATR', kLong: 2 },
];
const MIN_PRICE: Record<string, number> = { BTC: 5, ETH: 0.2, SOL: 0.1 };
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : x === Infinity ? 'inf' : '-');
const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const deliveryFee = (expiry: string, intrinsic: number, settle: number) =>
  intrinsic > 0 && new Date(`${expiry}T08:00:00Z`).getUTCDay() === 5 ? Math.min(FEES.delivery * settle, FEES.capShare * intrinsic) : 0;

for (const id of coins) {
  const dir = `data/history-daily/${id}`;
  const delivery: Record<string, number> = JSON.parse(readFileSync(`${dir}/delivery.json`, 'utf8'));
  const tapes = new Map<string, TapeTrade[]>();
  for (const fn of readdirSync(dir).sort()) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(fn)) tapes.set(fn.slice(0, 10), JSON.parse(readFileSync(`${dir}/${fn}`, 'utf8')));
  const { mornings } = prepareMornings(MARKETS[id], delivery, tapes, 1);

  // ATR as of each morning: mean |daily settlement move| over the previous ATR_DAYS days, percent.
  const dates = Object.keys(delivery).sort();
  const atrByDate = new Map<string, number>();
  for (let i = ATR_DAYS; i < dates.length; i++) {
    const moves: number[] = [];
    for (let j = i - ATR_DAYS + 1; j <= i; j++) moves.push(Math.abs(delivery[dates[j]] / delivery[dates[j - 1]] - 1) * 100);
    atrByDate.set(dates[i], moves.reduce((a, b) => a + b, 0) / moves.length);
  }
  const days = mornings.filter((m) => atrByDate.has(m.date));

  // Part 1: how often does the next settlement fall more than k × ATR?
  console.log(`\n=== ${id}: ${days.length} mornings, ATR over ${ATR_DAYS} days. Median ATR ${f(median(days.map((m) => atrByDate.get(m.date)!)))}% of price.`);
  const dist = K_SHORT.map((k) => {
    const hit = days.filter((m) => m.settle < m.spot * (1 - (k * atrByDate.get(m.date)!) / 100)).length;
    const hit26 = days.filter((m) => m.date >= '2026-01-01' && m.settle < m.spot * (1 - (k * atrByDate.get(m.date)!) / 100)).length;
    const n26 = days.filter((m) => m.date >= '2026-01-01').length;
    return { 'put sold at': `${k} × ATR below`, 'that is about': `${f(k * median(days.map((m) => atrByDate.get(m.date)!)), 2)}% below`, 'breached, all days': `${f((100 * hit) / days.length, 1)}%`, 'breached, 2026': `${f((100 * hit26) / n26, 1)}%` };
  });
  console.table(dist);

  // Part 2: spreads placed by ATR distance.
  const rows: Record<string, string | number>[] = [];
  for (const fill of ['mid', 'cross'] as const) {
    for (const k of K_SHORT) {
      for (const long of LONGS) {
        const trades: DailyTrade[] = [];
        let modelled = 0;
        const feeShare: number[] = [];
        for (const m of days) {
          const atr = atrByDate.get(m.date)!;
          const shortStrike = Math.floor((m.spot * (1 - (k * atr) / 100)) / m.step) * m.step;
          if (shortStrike >= m.spot) continue;
          const longStrike = long.steps ? shortStrike - long.steps * m.step : Math.min(shortStrike - m.step, Math.floor((m.spot * (1 - ((k + long.kLong!) * atr) / 100)) / m.step) * m.step);
          const t = (Date.parse(`${m.expiry}T08:00:00Z`) - Date.parse(`${m.date}T08:05:00Z`)) / YEAR_MS;
          const price = (strike: number, side: 'sell' | 'buy'): { p: number; real: boolean } | null => {
            const q = m.quotes.get(strike);
            if (q && (fill === 'mid' || (side === 'sell' ? q.bid : q.ask) !== undefined)) return { p: fill === 'mid' ? q.mid : side === 'sell' ? q.bid! : q.ask!, real: true };
            const near = [...m.quotes.values()].filter((x) => x.iv > 0);
            if (!near.length) return null;
            const ref = near.reduce((a, b) => (Math.abs(b.strike - strike) < Math.abs(a.strike - strike) ? b : a));
            const mid = Math.max(putPrice(m.spot, strike, t, ref.iv), MIN_PRICE[id]);
            return { p: fill === 'mid' ? mid : side === 'sell' ? mid - MIN_PRICE[id] : mid + MIN_PRICE[id], real: false };
          };
          const s = price(shortStrike, 'sell');
          const l = price(longStrike, 'buy');
          if (!s || !l) continue;
          if (!s.real || !l.real) modelled++;
          const fee = takerFee(s.p, m.spot) + takerFee(l.p, m.spot);
          const creditUsd = s.p - l.p - fee;
          const maxLossUsd = shortStrike - longStrike - creditUsd;
          if (!(creditUsd > 0) || !(maxLossUsd > 0)) continue;
          feeShare.push(fee / (s.p - l.p));
          const si = Math.max(shortStrike - m.settle, 0);
          const li = Math.max(longStrike - m.settle, 0);
          const pnlUsd = creditUsd - si + li - deliveryFee(m.expiry, si, m.settle) - deliveryFee(m.expiry, li, m.settle);
          trades.push({ entry: m.date, expiry: m.expiry, spot: m.spot, settle: m.settle, step: m.step, shortStrike, longStrike, creditUsd, maxLossUsd, pnlUsd, r: pnlUsd / maxLossUsd });
        }
        if (trades.length < 100) continue;
        const is = dailyStats(trades, ALL[0], IS_END, 0.95);
        const oos = dailyStats(trades, OOS[0], OOS[1], 0.95);
        rows.push({
          fill, 'sold put': `${k} × ATR`, 'bought put': long.label, trades: trades.length, 'modelled %': f((100 * modelled) / trades.length, 0),
          'fees % credit': f(100 * median(feeShare), 0), 'loss:credit': f(median(trades.map((t) => t.maxLossUsd / t.creditUsd)), 1),
          'IS win %': f(is.winPct, 1), 'IS %/deal': f(is.avgGainPct, 3), 'IS PF': f(is.profitFactor), 'IS Sharpe': f(is.sharpe),
          'OOS win %': f(oos.winPct, 1), 'OOS %/deal': f(oos.avgGainPct, 3), 'OOS PF': f(oos.profitFactor), 'OOS Sharpe': f(oos.sharpe), 'OOS maxDD %': f(oos.maxDrawdownPct, 1),
        });
      }
    }
  }
  const byIs = [...rows].filter((r) => r.fill === 'mid').sort((a, b) => Number(b['IS Sharpe']) - Number(a['IS Sharpe']));
  console.log(`\n${id}: best 8 by in-sample Sharpe (mid fills), then how they did in 2026:`);
  console.table(byIs.slice(0, 8));
  console.log(`\n${id}: the same settings at bid/ask fills:`);
  console.table(byIs.slice(0, 8).map((r) => rows.find((x) => x.fill === 'cross' && x['sold put'] === r['sold put'] && x['bought put'] === r['bought put'])).filter(Boolean));
  console.log(`\n${id}: current setting for reference (first strike below, 1 strike wide) sits at about ${f(median(days.map((m) => (100 * (m.spot - (Math.ceil(m.spot / m.step - 1e-9) * m.step - m.step))) / m.spot / atrByDate.get(m.date)!)), 2)} × ATR below the price.`);
  const profitable = rows.filter((r) => Number(r['IS PF']) > 1 && Number(r['OOS PF']) > 1);
  console.log(`${id}: settings profitable both in-sample and in 2026: ${profitable.length} of ${rows.length}` + (profitable.length ? '' : '.'));
  if (profitable.length) console.table(profitable);
}
