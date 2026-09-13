/**
 * Bull put spread backtest across BTC, ETH and SOL, in bull and range markets only.
 *
 *   npm run history    # once: cache the tape (several minutes)
 *   npm run backtest
 *
 * Two ways of deciding "not a red market", because they answer different questions:
 *   sma50    trade only when price is above its 50-day average. Knowable on the
 *            morning of the trade, so this is what following a rule really gets.
 *   quarter  trade only in calendar quarters that did not fall more than 10%.
 *            Picked with hindsight: the ceiling, what judging the cycle
 *            perfectly would have earned. Nobody gets to trade this one.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { regimeDates, runBacktest, summarize, type Config, type Regime } from '../lib/backtest.ts';
import type { TapeTrade } from '../lib/history.ts';

const DTES = [7, 14, 28];
const WIDTHS = [0.02, 0.04, 0.06, 0.08];
const CAPS = [1.5, 2, 3, 5];
const REGIMES: Regime[] = ['sma50', 'quarter'];

const flag = process.argv.indexOf('--markets');
const MARKET_IDS = (flag > 0 ? process.argv[flag + 1] : 'BTC,ETH,SOL').split(',') as MarketId[];

async function load(id: MarketId) {
  const dir = `data/history/${id}`;
  const delivery: Record<string, number> = JSON.parse(await readFile(`${dir}/delivery.json`, 'utf8'));
  const tapes = new Map<string, TapeTrade[]>();
  for (const f of (await readdir(dir)).sort()) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) tapes.set(f.slice(0, 10), JSON.parse(await readFile(`${dir}/${f}`, 'utf8')));
  }
  return { delivery, tapes };
}

const fmt = (x: unknown, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '-');

const results: any[] = [];
for (const id of MARKET_IDS as MarketId[]) {
  const { delivery, tapes } = await load(id);
  for (const regime of REGIMES) {
    const allowed = regimeDates(regime, delivery);
    for (const dte of DTES) for (const widthPct of WIDTHS) for (const maxLossToCredit of CAPS) {
      const cfg: Config = { dte, widthPct, maxLossToCredit };
      const run = runBacktest(MARKETS[id], delivery, tapes, cfg, allowed);
      results.push({ market: id, regime, cfg, counts: run.counts, years: run.years, stats: summarize(run.trades, cfg, run.years), trades: run.trades });
    }
  }
}
await writeFile('data/backtest-results.json', JSON.stringify(results));

for (const id of MARKET_IDS) {
  for (const regime of REGIMES) {
    const rows = results.filter((r) => r.market === id && r.regime === regime && r.cfg.maxLossToCredit === 2);
    const c = rows[0]?.counts;
    console.log(`\n${id} · ${regime} · risk $2 to make $1 · ${c?.entries} Fridays, ${c?.offRegime} off-regime, ${c?.noData} no data, ${c?.unsettled} unsettled`);
    console.table(rows.map((r) => ({
      dte: r.cfg.dte,
      width: `${r.cfg.widthPct * 100}%`,
      trades: r.stats.n,
      'rule not met': r.counts.ruleNotMet,
      'no quotes': r.counts.noQuotes,
      'win %': fmt(r.stats.winPct),
      'market win %': fmt(r.stats.impliedWinPct),
      'avg R': fmt(r.stats.avgR, 3),
      'total R': fmt(r.stats.totalR, 2),
      'worst R': fmt(r.stats.worstR, 2),
      'max DD R': fmt(r.stats.maxDrawdownR, 2),
      'yearly %': fmt(r.stats.annualReturnPct),
      'OTM %': fmt(r.stats.distancePct),
      delta: fmt(r.stats.shortDelta, 2),
      'loss:credit': fmt(r.stats.lossToCredit, 2),
      'friction %': fmt(r.stats.frictionPct),
    })));
  }
}

console.log('\nRisk rule trade-off, median across all expiries and widths (configs with 10+ trades):');
const table: any[] = [];
for (const id of MARKET_IDS) for (const regime of REGIMES) for (const cap of CAPS) {
  const rows = results.filter((r) => r.market === id && r.regime === regime && r.cfg.maxLossToCredit === cap && r.stats.n >= 10);
  const med = (f: (r: any) => number) => {
    const s = rows.map(f).filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : NaN;
  };
  table.push({
    market: id, regime, 'max loss : credit': cap, configs: rows.length,
    'win %': fmt(med((r) => r.stats.winPct)),
    'avg R': fmt(med((r) => r.stats.avgR), 3),
    'yearly %': fmt(med((r) => r.stats.annualReturnPct)),
    'OTM %': fmt(med((r) => r.stats.distancePct)),
    'friction %': fmt(med((r) => r.stats.frictionPct)),
  });
}
console.table(table);
