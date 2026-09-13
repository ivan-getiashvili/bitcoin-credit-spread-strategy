/**
 * Grid search for the daily put spread, with an honest out-of-sample test.
 *
 *   npm run history:daily   # once: cache every morning's tape (tens of minutes)
 *   npm run grid
 *
 * The best setting is chosen on IN-SAMPLE mornings only (8 Mar 2024 - 31 Dec 2025),
 * then scored on 2026, which the choice never saw. With 64 settings per coin, some will
 * look good in-sample by luck; the out-of-sample columns are what to believe.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { regimeDates } from '../lib/backtest.ts';
import { dailyStats, prepareMornings, runDaily, type DailyConfig } from '../lib/daily-backtest.ts';
import type { TapeTrade } from '../lib/history.ts';
import { MARKETS, type MarketId } from '../lib/markets.ts';

const RISK_PCT = 2;
const IS_FROM = '2024-03-08';
const IS_TO = '2025-12-31';
const OOS_FROM = '2026-01-01';
const MIN_TRADES = 100;
const CURRENT: Omit<DailyConfig, 'fill'> = { shortRank: 1, width: 1, dte: 1, filter: 'none' };

const flag = process.argv.indexOf('--markets');
const ids = (flag > 0 ? process.argv[flag + 1] : 'BTC,ETH').split(',') as MarketId[];
const fmt = (x: unknown, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : x === Infinity ? 'inf' : '-');
const name = (c: Omit<DailyConfig, 'fill'>) => `sell #${c.shortRank}, width ${c.width}, ${c.dte}d, ${c.filter}`;

const out: any[] = [];
for (const id of ids) {
  const dir = `data/history-daily/${id}`;
  const delivery: Record<string, number> = JSON.parse(readFileSync(`${dir}/delivery.json`, 'utf8'));
  const tapes = new Map<string, TapeTrade[]>();
  for (const f of readdirSync(dir).sort()) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) tapes.set(f.slice(0, 10), JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
  }
  const dates = [...tapes.keys()].sort();
  const OOS_TO = dates.at(-1)!;
  const sma = regimeDates('sma50', delivery);
  console.log(`\n${id}: ${tapes.size} mornings, ${dates[0]} to ${OOS_TO}`);

  const prepared = { 1: prepareMornings(MARKETS[id], delivery, tapes, 1), 2: prepareMornings(MARKETS[id], delivery, tapes, 2) } as const;
  for (const dte of [1, 2] as const) {
    const steps = new Map<number, number>();
    for (const m of prepared[dte].mornings) steps.set(m.step, (steps.get(m.step) ?? 0) + 1);
    console.log(`  ${dte}-day expiry: ${prepared[dte].mornings.length} usable mornings, skipped ${JSON.stringify(prepared[dte].skipped)}, strike steps ${JSON.stringify(Object.fromEntries([...steps].sort((a, b) => b[1] - a[1]).slice(0, 5)))}`);
  }

  const rows: any[] = [];
  for (const dte of [1, 2] as const) for (const shortRank of [1, 2, 3, 4]) for (const width of [1, 2, 3, 4]) for (const filter of ['none', 'sma50'] as const) {
    const base = { shortRank, width, dte, filter };
    const row: any = { market: id, config: base, name: name(base) };
    for (const fill of ['mid', 'cross'] as const) {
      const run = runDaily(prepared[dte].mornings, { ...base, fill }, filter === 'sma50' ? sma : null);
      row[fill] = { is: dailyStats(run.trades, IS_FROM, IS_TO, RISK_PCT), oos: dailyStats(run.trades, OOS_FROM, OOS_TO, RISK_PCT), skipped: run.skipped };
    }
    rows.push(row);
  }
  out.push(...rows);

  const line = (r: any) => ({
    setting: r.name,
    'IS trades': r.mid.is.trades,
    'IS win %': fmt(r.mid.is.winPct, 1),
    'IS avg %/deal': fmt(r.mid.is.avgGainPct, 3),
    'IS Sharpe': fmt(r.mid.is.sharpe),
    'OOS trades': r.mid.oos.trades,
    'OOS win %': fmt(r.mid.oos.winPct, 1),
    'OOS avg %/deal': fmt(r.mid.oos.avgGainPct, 3),
    'OOS PF': fmt(r.mid.oos.profitFactor),
    'OOS Sharpe': fmt(r.mid.oos.sharpe),
    'OOS max DD %': fmt(r.mid.oos.maxDrawdownPct, 1),
    'OOS Sharpe at bid/ask': fmt(r.cross.oos.sharpe),
    'loss:credit': fmt(r.mid.is.medianLossToCredit, 1),
  });

  const eligible = rows.filter((r) => r.mid.is.trades >= MIN_TRADES && Number.isFinite(r.mid.is.sharpe));
  const ranked = [...eligible].sort((a, b) => b.mid.is.sharpe - a.mid.is.sharpe);
  console.log(`\n${id}: top 10 settings chosen on IN-SAMPLE Sharpe (mid fills), with their unseen 2026 results`);
  console.table(ranked.slice(0, 10).map(line));
  const current = rows.find((r) => JSON.stringify(r.config) === JSON.stringify(CURRENT));
  console.log(`${id}: the bot's current setting`);
  console.table([line(current)]);
  const posIs = eligible.filter((r) => r.mid.is.avgR > 0);
  const stay = posIs.filter((r) => r.mid.oos.avgR > 0);
  console.log(`${id}: ${posIs.length} of ${eligible.length} settings made money in-sample at mid fills; ${stay.length} of those still did in 2026. At bid/ask fills, ${eligible.filter((r) => r.cross.is.avgR > 0).length} made money in-sample.`);
}
writeFileSync('data/grid-results.json', JSON.stringify(out));
