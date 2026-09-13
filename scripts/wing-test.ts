/**
 * Tests Ivan's idea: sell the first put below the price, buy the protective put much
 * further down, and let each spread risk 2% or 5% of the account.
 *
 *   npm run wing-test
 *
 * Daily BTC puts (1-day expiry), every morning 8 Mar 2024 - 13 Sep 2026. Far-out puts
 * rarely trade, so when the bought strike has no trades that morning its price comes
 * from Black-76 at the implied volatility of the nearest traded strike below the sold
 * one, never below one BTC_USDC tick (5 USDC). Flat volatility understates far-out puts,
 * which makes wide spreads look slightly better than they are; the "long priced from
 * trades" column shows how much rests on that estimate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { putPrice } from '../lib/blackscholes.ts';
import { dailyStats, prepareMornings, type DailyTrade } from '../lib/daily-backtest.ts';
import type { TapeTrade } from '../lib/history.ts';
import { MARKETS } from '../lib/markets.ts';
import { FEES, takerFee } from '../lib/spread.ts';

const WIDTHS_PCT = [0.65, 1.3, 2, 3, 4, 5, 6.5, 8, 10];
const MIN_PRICE = 5;
/** --combo-fees: price the spread as one Deribit combo order, where the cheaper leg's fee is waived. */
const COMBO = process.argv.includes('--combo-fees');
const YEAR_MS = 365 * 86_400_000;
const FULL = ['2024-03-08', '2026-09-13'] as const;
const Y2026 = ['2026-01-01', '2026-09-13'] as const;

const dir = 'data/history-daily/BTC';
const delivery: Record<string, number> = JSON.parse(readFileSync(`${dir}/delivery.json`, 'utf8'));
const tapes = new Map<string, TapeTrade[]>();
for (const f of readdirSync(dir).sort()) {
  if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) tapes.set(f.slice(0, 10), JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
}
const { mornings } = prepareMornings(MARKETS.BTC, delivery, tapes, 1);

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : x === Infinity ? 'inf' : '-');
const deliveryFee = (expiry: string, intrinsic: number, settle: number) =>
  intrinsic > 0 && new Date(`${expiry}T08:00:00Z`).getUTCDay() === 5 ? Math.min(FEES.delivery * settle, FEES.capShare * intrinsic) : 0;

type Row = Record<string, string | number>;
const economics: Row[] = [];
const results: Row[] = [];

for (const fill of ['mid', 'cross'] as const) {
  for (const pct of WIDTHS_PCT) {
    const trades: DailyTrade[] = [];
    let real = 0;
    const gross: number[] = [];
    const fees: number[] = [];
    const longPx: number[] = [];
    for (const m of mornings) {
      const first = Math.ceil(m.spot / m.step - 1e-9) * m.step - m.step;
      const s = m.quotes.get(first);
      const sell = fill === 'mid' ? s?.mid : s?.bid;
      if (sell === undefined) continue;
      const longStrike = Math.min(Math.round((first - (pct / 100) * m.spot) / m.step) * m.step, first - m.step);

      let buy: number;
      const traded = m.quotes.get(longStrike);
      if (traded && (fill === 'mid' || traded.ask !== undefined)) {
        buy = fill === 'mid' ? traded.mid : traded.ask!;
        real++;
      } else {
        // Nearest traded strike at or below the sold one supplies the volatility.
        const below = [...m.quotes.values()].filter((q) => q.strike <= first && q.iv > 0);
        if (!below.length) continue;
        const ref = below.reduce((a, b) => (Math.abs(b.strike - longStrike) < Math.abs(a.strike - longStrike) ? b : a));
        const t = (Date.parse(`${m.expiry}T08:00:00Z`) - Date.parse(`${m.date}T08:05:00Z`)) / YEAR_MS;
        const mid = Math.max(putPrice(m.spot, longStrike, t, ref.iv), MIN_PRICE);
        buy = fill === 'mid' ? mid : mid + MIN_PRICE;
      }

      const legFees = [takerFee(sell, m.spot), takerFee(buy, m.spot)];
      // Deribit's option combo discount: for a taker, the cheaper leg's fee is waived.
      const fee = COMBO ? Math.max(...legFees) : legFees[0] + legFees[1];
      const creditUsd = sell - buy - fee;
      const widthUsd = first - longStrike;
      const maxLossUsd = widthUsd - creditUsd;
      if (!(creditUsd > 0) || !(maxLossUsd > 0)) continue;
      const si = Math.max(first - m.settle, 0);
      const li = Math.max(longStrike - m.settle, 0);
      const pnlUsd = creditUsd - si + li - deliveryFee(m.expiry, si, m.settle) - deliveryFee(m.expiry, li, m.settle);
      trades.push({ entry: m.date, expiry: m.expiry, spot: m.spot, settle: m.settle, step: m.step, shortStrike: first, longStrike, creditUsd, maxLossUsd, pnlUsd, r: pnlUsd / maxLossUsd });
      gross.push(sell - buy);
      fees.push(fee);
      longPx.push(buy);
    }

    const lc = median(trades.map((t) => t.maxLossUsd / t.creditUsd));
    if (fill === 'mid') {
      economics.push({
        'bought put below sold': `${pct}%`,
        trades: trades.length,
        'long priced from trades %': f((100 * real) / Math.max(trades.length, 1), 0),
        'median long put $': f(median(longPx), 0),
        'median credit before fees $': f(median(gross), 0),
        'median fees $': f(median(fees), 1),
        'fees % of credit': f(100 * median(fees.map((x, i) => x / gross[i])), 0),
        'max loss : credit': f(lc, 1),
        'wins needed to break even %': f((100 * lc) / (1 + lc), 0),
        'wins achieved %': f(dailyStats(trades, ...FULL, 2).winPct, 1),
      });
    }
    for (const risk of [2, 5]) {
      const a = dailyStats(trades, ...FULL, risk);
      const b = dailyStats(trades, ...Y2026, risk);
      results.push({
        fill,
        'bought put below sold': `${pct}%`,
        risk: `${risk}%`,
        'avg %/deal': f(a.avgGainPct, 3),
        'profit factor': f(a.profitFactor),
        Sharpe: f(a.sharpe),
        'total return %': f(a.totalReturnPct, 0),
        'max drawdown %': f(a.maxDrawdownPct, 0),
        '2026 avg %/deal': f(b.avgGainPct, 3),
        '2026 return %': f(b.totalReturnPct, 0),
        '2026 max DD %': f(b.maxDrawdownPct, 0),
      });
    }
  }
}

console.log('\nWhat each width costs and needs (sell the first put below the price, 1-day BTC, mid prices):');
console.table(economics);
console.log('\nResults, whole period and 2026 alone:');
console.table(results);
