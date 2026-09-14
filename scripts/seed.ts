/**
 * Builds the simulated history the dashboard shows until the bot has seven real daily
 * returns (lib/seed.ts): the current strategy run on real morning prices for the days
 * before launch, sized like the live bot.
 *
 *   npm run history:daily -- --from <start> --markets BTC,ETH   # refresh the price cache
 *   npm run seed -- --to 2026-09-13 --days 8                      # -> data/seed.json
 *
 * Only BTC and ETH have cached history; SOL is left out. Deals are at mid prices with
 * Deribit's fees, sized at riskPerTradePct of capitalUsd with sizingSlackPct, no compounding.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { prepareMornings, runDaily } from '../lib/daily-backtest.ts';
import type { SpreadRecord } from '../lib/executor.ts';
import type { TapeTrade } from '../lib/history.ts';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import type { EquitySample } from '../lib/metrics.ts';
import type { Seed } from '../lib/seed.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const config = JSON.parse(readFileSync('bot.config.json', 'utf8'));
const DAY = 86_400_000;
const to = arg('to', new Date(Date.now() - DAY).toISOString().slice(0, 10));
const days = Number(arg('days', '8'));
const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY).toISOString().slice(0, 10);
const capital: number = config.capitalUsd;
const riskPct: number = config.riskPerTradePct;
const slack: number = config.sizingSlackPct ?? 0;
const MIN_AMOUNT: Record<string, number> = { BTC: 0.01, ETH: 0.1, SOL: 10 };
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const name = (id: string, expiry: string, strike: number) => {
  const d = new Date(`${expiry}T08:00:00Z`);
  return `${id}_USDC-${d.getUTCDate()}${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}-${strike}-P`;
};
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;

const spreads: SpreadRecord[] = [];
const markets: string[] = [];
for (const id of ['BTC', 'ETH'] as MarketId[]) {
  const dir = `data/history-daily/${id}`;
  let delivery: Record<string, number>;
  try { delivery = JSON.parse(readFileSync(`${dir}/delivery.json`, 'utf8')); } catch { console.log(`${id}: no cached history, skipped`); continue; }
  const tapes = new Map<string, TapeTrade[]>();
  for (const f of readdirSync(dir)) {
    const date = f.slice(0, 10);
    // Entries from the day before `from` settle on `from`.
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && date >= new Date(Date.parse(`${from}T00:00:00Z`) - DAY).toISOString().slice(0, 10) && date < to) {
      tapes.set(date, JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
    }
  }
  const { mornings } = prepareMornings(MARKETS[id], delivery, tapes, 1);
  const { trades, skipped } = runDaily(mornings, { shortRank: 1, width: 1, dte: 1, filter: 'none', fill: 'mid' }, null);
  const riskUsd = (capital * riskPct) / 100;
  let n = 0;
  for (const t of trades) {
    if (t.expiry < from || t.expiry > to) continue;
    const step = MIN_AMOUNT[id];
    const amount = r8(Math.floor((riskUsd * (1 - slack / 100)) / t.maxLossUsd / step + 1e-9) * step);
    if (amount < step) continue;
    n += 1;
    spreads.push({
      id: `sim-${id}-${t.entry}`,
      market: id,
      expiry: t.expiry,
      expiryMs: Date.parse(`${t.expiry}T08:00:00Z`),
      openedAt: `${t.entry}T08:05:00.000Z`,
      entrySpot: t.spot,
      shortName: name(id, t.expiry, t.shortStrike),
      shortStrike: t.shortStrike,
      longName: name(id, t.expiry, t.longStrike),
      longStrike: t.longStrike,
      plannedAmount: amount,
      riskUsd,
      accountUsdAtEntry: capital,
      minCreditQuote: 0,
      amount: 0,
      spareLong: 0,
      openedAmount: amount,
      cashQuote: r8(t.pnlUsd * amount),
      fills: [],
      creditUsd: t.creditUsd,
      maxLossUsd: t.maxLossUsd,
      lossToCredit: t.maxLossUsd / t.creditUsd,
      status: 'settled',
      closedAt: `${t.expiry}T08:00:00.000Z`,
      settlePrice: t.settle,
      pnlUsd: r8(t.pnlUsd * amount),
      simulated: true,
    });
  }
  console.log(`${id}: ${mornings.length} mornings priced, ${n} simulated deals from ${from} to ${to}${Object.values(skipped).some(Boolean) ? ` (skipped ${JSON.stringify(skipped)})` : ''}`);
  if (n) markets.push(id);
}

// One close per day: cumulative P&L of the deals settled by the end of that day.
const closes: EquitySample[] = [];
let cum = 0;
for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += DAY) {
  const day = new Date(d).toISOString().slice(0, 10);
  cum += spreads.filter((s) => s.expiry === day).reduce((a, s) => a + (s.pnlUsd ?? 0), 0);
  closes.push({ t: d + DAY - 60_000, equityUsd: capital + cum, strategyUsd: cum });
}

const seed: Seed = { generatedAt: new Date().toISOString(), from, to, capitalUsd: capital, riskPerTradePct: riskPct, markets, spreads, closes };
writeFileSync('data/seed.json', JSON.stringify(seed));
console.log(`\ndata/seed.json: ${closes.length} daily closes, ${spreads.length} deals, cumulative P&L $${cum.toFixed(2)}`);
for (const s of spreads) console.log(`  ${s.market} ${s.openedAt.slice(0, 10)} ${s.shortStrike}/${s.longStrike} × ${s.openedAmount} settled ${s.settlePrice}: ${s.pnlUsd! >= 0 ? '+' : ''}${s.pnlUsd!.toFixed(2)}`);
