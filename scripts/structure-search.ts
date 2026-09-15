/**
 * Ivan's hypotheses (2026-09-15): would call spreads, iron condors (a put spread below the
 * price and a call spread above it), or weekly / monthly expiries do better than the daily
 * put spread? And by how much do fees decide it?
 *
 *   npm run history:tapes            # first: puts and calls for the expiries below
 *   npm run structures -- [--coins BTC,ETH]
 *
 * Every entry is the 08:05 UTC morning after a settlement, on real trades from that
 * morning's 08:00-10:00 window (data/history-tapes). Three expiry classes:
 *   daily    every morning, expiring next 08:00 (1 day)
 *   weekly   Friday mornings, expiring next Friday (7 days)
 *   monthly  the last Friday of each month, expiring the last Friday of the next month
 * Strikes sit k × ATR14 × sqrt(days) away from the price ("first strike out" is k = 0);
 * the bought leg is 1-2 strikes or one horizon-ATR further. Legs that traded that morning
 * are priced at their mids (or bid/ask for "cross"); untraded legs by Black-76 at the
 * nearest traded strike's volatility. Deribit fees on every leg, delivery fees on Friday
 * expiries, 1% risk with 5% slack, no compounding. Settings are ranked in-sample (entries
 * to 2025-12-31) and judged on 2026.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { callPrice, putPrice } from '../lib/blackscholes.ts';
import type { TapeTrade } from '../lib/history.ts';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { FEES, takerFee } from '../lib/spread.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const coins = arg('coins', 'BTC,ETH').split(',') as MarketId[];
const DAY = 86_400_000;
const YEAR = 365 * DAY;
const ATR_DAYS = 14;
const IS_END = '2025-12-31';
const CAPITAL = 100_000;
const RISK = 0.01 * 0.95;
const MIN_TRADES = { daily: 100, weekly: 40, monthly: 12 };
const MIN_PRICE: Record<string, number> = { BTC: 5, ETH: 0.5 };
const K = [0, 0.5, 1, 1.5, 2];
const LONGS: { label: string; steps?: number; atr?: number }[] = [{ label: '1 strike', steps: 1 }, { label: '2 strikes', steps: 2 }, { label: '+1 ATR', atr: 1 }];
type Structure = 'put spread' | 'call spread' | 'iron condor';
type Class = 'daily' | 'weekly' | 'monthly';

type Quote = { strike: number; mid: number; bid?: number; ask?: number; iv: number };
type Trade = { entry: string; expiry: string; pnl: number; maxLoss: number; credit: number; gross: number; fee: number; modelled: boolean };

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : x === Infinity ? 'inf' : '-');
const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isFriday = (date: string) => new Date(`${date}T08:00:00Z`).getUTCDay() === 5;
const lastFridayMs = (y: number, m: number) => { const end = Date.UTC(y, m + 1, 0, 8); return end - ((new Date(end).getUTCDay() + 2) % 7) * DAY; };
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const deliveryFee = (expiry: string, intrinsic: number, settle: number) =>
  intrinsic > 0 && isFriday(expiry) ? Math.min(FEES.delivery * settle, FEES.capShare * intrinsic) : 0;

/** Traded quotes for one expiry and type, moved to the entry moment, in dollars. */
function quotes(tape: TapeTrade[], expiryMs: number, entryMs: number, spot: number, type: 'put' | 'call', inverse: boolean): Map<number, Quote> {
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

function stats(trades: Trade[], from: string, to: string) {
  const ts = trades.filter((t) => t.entry >= from && t.entry <= to);
  const n = ts.length;
  if (!n) return { n: 0, winPct: NaN, avgPct: NaN, pf: NaN, sharpe: NaN, totalPct: NaN, maxDdPct: NaN };
  const units = (t: Trade) => (CAPITAL * RISK) / t.maxLoss;
  const pnls = ts.map((t) => t.pnl * units(t));
  const wins = pnls.filter((p) => p > 0);
  const byDay = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) byDay.set(ts[i].expiry, (byDay.get(ts[i].expiry) ?? 0) + pnls[i] / CAPITAL);
  const daily: number[] = [];
  let eq = 1; let peak = 1; let maxDd = 0;
  const end = Math.max(...ts.map((t) => Date.parse(`${t.expiry}T00:00:00Z`)));
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= end; d += DAY) {
    const r = byDay.get(iso(d)) ?? 0;
    daily.push(r); eq *= 1 + r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak);
  }
  const mean = sum(daily) / daily.length;
  const sd = Math.sqrt(sum(daily.map((r) => (r - mean) ** 2)) / Math.max(daily.length - 1, 1));
  const gl = -sum(pnls.filter((p) => p < 0));
  return { n, winPct: (100 * wins.length) / n, avgPct: (100 * sum(pnls)) / n / CAPITAL, pf: gl > 0 ? sum(wins) / gl : sum(wins) > 0 ? Infinity : NaN, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : NaN, totalPct: (eq - 1) * 100, maxDdPct: maxDd * 100 };
}

for (const id of coins) {
  const market = MARKETS[id];
  const inverse = market.settlement === 'inverse';
  const dir = `data/history-tapes/${id}`;
  const delivery: Record<string, number> = JSON.parse(readFileSync(`${dir}/delivery.json`, 'utf8'));
  const dates = Object.keys(delivery).sort();
  const atr = new Map<string, number>();
  for (let i = ATR_DAYS; i < dates.length; i++) {
    const moves: number[] = [];
    for (let j = i - ATR_DAYS + 1; j <= i; j++) moves.push(Math.abs(delivery[dates[j]] / delivery[dates[j - 1]] - 1));
    atr.set(dates[i], sum(moves) / moves.length);
  }
  const files = readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
  console.log(`\n==================== ${id}: ${files.length} mornings cached ====================`);

  const classes: Record<Class, { date: string; expiryMs: number }[]> = { daily: [], weekly: [], monthly: [] };
  for (const file of files) {
    const date = file.slice(0, 10);
    const ms = Date.parse(`${date}T08:00:00Z`);
    classes.daily.push({ date, expiryMs: ms + DAY });
    if (isFriday(date)) {
      classes.weekly.push({ date, expiryMs: ms + 7 * DAY });
      const d = new Date(ms);
      if (lastFridayMs(d.getUTCFullYear(), d.getUTCMonth()) === ms) classes.monthly.push({ date, expiryMs: lastFridayMs(d.getUTCFullYear(), d.getUTCMonth() + 1) });
    }
  }

  for (const cls of ['daily', 'weekly', 'monthly'] as Class[]) {
    // Price every entry once per configuration; the tape is read once per entry.
    const rows: Record<string, string | number>[] = [];
    let skippedImplausible = 0;
    const prepared: { date: string; expiry: string; spot: number; settle: number; atrH: number; step: number; puts: Map<number, Quote>; calls: Map<number, Quote>; t0: number }[] = [];
    for (const e of classes[cls]) {
      const spot = delivery[e.date];
      const expiry = iso(e.expiryMs);
      const settle = delivery[expiry];
      const a = atr.get(e.date);
      if (!spot || !settle || !a) continue;
      const tape: TapeTrade[] = JSON.parse(readFileSync(`${dir}/${e.date}.json`, 'utf8'));
      const entryMs = e.expiryMs - Math.round((e.expiryMs - Date.parse(`${e.date}T08:05:00Z`)) / DAY) * DAY + 5 * 60_000;
      const puts = quotes(tape, e.expiryMs, Date.parse(`${e.date}T08:05:00Z`), spot, 'put', inverse);
      const calls = quotes(tape, e.expiryMs, Date.parse(`${e.date}T08:05:00Z`), spot, 'call', inverse);
      if (!puts.size && !calls.size) continue;
      const strikes = [...new Set([...puts.keys(), ...calls.keys()])].filter((k) => Math.abs(k / spot - 1) < 0.1).sort((x, y) => x - y);
      let step = Infinity;
      for (let i = 1; i < strikes.length; i++) step = Math.min(step, strikes[i] - strikes[i - 1]);
      if (!Number.isFinite(step)) continue;
      const days = (e.expiryMs - Date.parse(`${e.date}T08:05:00Z`)) / DAY;
      prepared.push({ date: e.date, expiry, spot, settle, atrH: a * Math.sqrt(days), step, puts, calls, t0: days / YEAR });
      void entryMs;
    }
    if (!prepared.length) { console.log(`\n${cls}: no priced entries`); continue; }
    const isN = prepared.filter((p) => p.date <= IS_END).length;
    console.log(`\n--- ${cls}: ${prepared.length} entries (${isN} in-sample, ${prepared.length - isN} in 2026), median horizon ATR ${f(100 * median(prepared.map((p) => p.atrH)), 2)}%, median strike step ${median(prepared.map((p) => p.step))} ---`);

    for (const structure of ['put spread', 'call spread', 'iron condor'] as Structure[]) {
      for (const fill of ['mid', 'cross'] as const) {
        for (const k of K) {
          for (const long of LONGS) {
            const trades: Trade[] = [];
            let implausible = 0;
            for (const p of prepared) {
              const price = (book: Map<number, Quote>, type: 'put' | 'call', strike: number, side: 'sell' | 'buy'): { p: number; real: boolean } | null => {
                const q = book.get(strike);
                if (q && (fill === 'mid' || (side === 'sell' ? q.bid : q.ask) !== undefined)) return { p: fill === 'mid' ? q.mid : side === 'sell' ? q.bid! : q.ask!, real: true };
                const near = [...book.values()];
                if (!near.length) return null;
                const ref = near.reduce((a, b) => (Math.abs(b.strike - strike) < Math.abs(a.strike - strike) ? b : a));
                const m = Math.max((type === 'put' ? putPrice : callPrice)(p.spot, strike, p.t0, ref.iv), MIN_PRICE[id]);
                return { p: fill === 'mid' ? m : side === 'sell' ? m - MIN_PRICE[id] : m + MIN_PRICE[id], real: false };
              };
              // Put wing: sold at the highest strike at least k × ATR below; call wing mirrored above.
              const wing = (type: 'put' | 'call') => {
                const dist = k * p.atrH;
                const short = type === 'put' ? Math.floor((p.spot * (1 - dist)) / p.step) * p.step : Math.ceil((p.spot * (1 + dist)) / p.step) * p.step;
                if (type === 'put' ? short >= p.spot : short <= p.spot) return null;
                const further = long.steps ? long.steps * p.step : Math.max(p.step, Math.round((p.atrH * long.atr! * p.spot) / p.step) * p.step);
                const lng = type === 'put' ? short - further : short + further;
                const book = type === 'put' ? p.puts : p.calls;
                const s = price(book, type, short, 'sell');
                const l = price(book, type, lng, 'buy');
                if (!s || !l) return null;
                const fee = takerFee(s.p, p.spot) + takerFee(l.p, p.spot);
                const gross = s.p - l.p;
                const width = Math.abs(short - lng);
                const si = type === 'put' ? Math.max(short - p.settle, 0) : Math.max(p.settle - short, 0);
                const li = type === 'put' ? Math.max(lng - p.settle, 0) : Math.max(p.settle - lng, 0);
                const settleCost = si - li + deliveryFee(p.expiry, si, p.settle) + deliveryFee(p.expiry, li, p.settle);
                return { gross, fee, width, settleCost, modelled: !s.real || !l.real };
              };
              const wings = structure === 'put spread' ? [wing('put')] : structure === 'call spread' ? [wing('call')] : [wing('put'), wing('call')];
              if (wings.some((w) => !w)) continue;
              const gross = sum(wings.map((w) => w!.gross));
              const fee = sum(wings.map((w) => w!.fee));
              const credit = gross - fee;
              // Only one wing can finish in the money, so the condor risks its wider wing minus the whole credit.
              const maxLoss = Math.max(...wings.map((w) => w!.width)) - credit;
              if (!(credit > 0) || !(maxLoss > 0)) continue;
              // A credit above 60% of the width is a mispriced leg, not a trade anyone was offered.
              if (credit > 0.6 * Math.max(...wings.map((w) => w!.width))) { implausible++; continue; }
              trades.push({ entry: p.date, expiry: p.expiry, pnl: credit - sum(wings.map((w) => w!.settleCost)), maxLoss, credit, gross, fee, modelled: wings.some((w) => w!.modelled) });
            }
            if (trades.length < MIN_TRADES[cls]) continue;
            if (implausible) skippedImplausible += implausible;
            const is = stats(trades, '2024-01-01', IS_END);
            const oos = stats(trades, '2026-01-01', '2026-12-31');
            rows.push({
              structure, fill, 'sold at': k ? `${k} × ATR` : 'first strike out', 'bought': long.label, trades: trades.length,
              'modelled %': f((100 * trades.filter((t) => t.modelled).length) / trades.length, 0),
              'fees % credit': f(100 * median(trades.map((t) => t.fee / t.gross)), 0), 'loss:credit': f(median(trades.map((t) => t.maxLoss / t.credit)), 1),
              'IS win %': f(is.winPct, 0), 'IS %/deal': f(is.avgPct, 3), 'IS PF': f(is.pf), 'IS Sharpe': f(is.sharpe),
              'OOS n': oos.n, 'OOS win %': f(oos.winPct, 0), 'OOS %/deal': f(oos.avgPct, 3), 'OOS PF': f(oos.pf), 'OOS Sharpe': f(oos.sharpe), 'OOS maxDD %': f(oos.maxDdPct, 1),
            });
          }
        }
      }
    }
    const compact = ({ structure, fill, ...r }: Record<string, string | number>) => ({ structure, fill, 'sold at': r['sold at'], bought: r.bought, n: r.trades, 'model%': r['modelled %'], 'fee%': r['fees % credit'], 'L:C': r['loss:credit'], 'IS win%': r['IS win %'], 'IS PF': r['IS PF'], 'IS Sh': r['IS Sharpe'], 'OOS n': r['OOS n'], 'OOS %/deal': r['OOS %/deal'], 'OOS PF': r['OOS PF'], 'OOS Sh': r['OOS Sharpe'], 'OOS DD%': r['OOS maxDD %'] });
    const shown: Record<string, string | number>[] = [];
    for (const structure of ['put spread', 'call spread', 'iron condor'] as Structure[]) {
      const mid = rows.filter((r) => r.structure === structure && r.fill === 'mid').sort((a, b) => Number(b['IS Sharpe']) - Number(a['IS Sharpe']));
      if (!mid.length) continue;
      const naive = mid.find((r) => r['sold at'] === 'first strike out' && r.bought === '1 strike');
      const best = mid[0];
      const bestCross = rows.find((r) => r.structure === structure && r.fill === 'cross' && r['sold at'] === best['sold at'] && r.bought === best.bought);
      shown.push(compact(best));
      if (bestCross) shown.push(compact(bestCross));
      if (naive && naive !== best) shown.push(compact(naive));
      const both = rows.filter((r) => r.structure === structure && Number(r['IS PF']) > 1 && Number(r['OOS PF']) > 1);
      console.log(`${cls} · ${structure}: profitable in-sample AND in 2026: ${both.length} of ${rows.filter((r) => r.structure === structure).length} settings (${both.filter((r) => r.fill === 'cross').length} of those at bid/ask)`);
      for (const r of both.filter((r) => r.fill === 'cross')) shown.push({ ...compact(r), structure: `${structure} ✓` });
    }
    if (skippedImplausible) console.log(`(${skippedImplausible} mispriced spreads skipped across all settings)`);
    console.log(`${cls}: best setting per structure (mids), its bid/ask fill, the naive setting, and every setting profitable in both periods at bid/ask (✓):`);
    console.table(shown);
  }
}
