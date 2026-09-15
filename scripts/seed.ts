/**
 * Builds the simulated history the dashboard shows until the bot has seven real daily
 * returns (lib/seed.ts): the live strategy run on real morning prices for the weeks
 * before launch, sized like the live bot.
 *
 *   npm run history:tapes -- --from <start> --markets BTC,ETH   # refresh the price cache
 *   npm run seed -- --to 2026-09-11 --weeks 10                    # -> data/seed.json
 *
 * Reads bot.config.json: per coin its structure (put or call spread), the strategy's
 * distance in ATRs and bought-leg offset, risk and slack. Bid/ask fills, Deribit fees,
 * delivery fees on Friday expiries, no compounding. `--to` is the last settlement Friday.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { OptionType, SpreadRecord } from '../lib/executor.ts';
import type { MarketId } from '../lib/markets.ts';
import type { EquitySample } from '../lib/metrics.ts';
import type { Seed } from '../lib/seed.ts';
import { simulateWeekly } from '../lib/weekly-backtest.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const config = JSON.parse(readFileSync('bot.config.json', 'utf8'));
const DAY = 86_400_000;
const to = arg('to', '');
if (!to) throw new Error('--to <last settlement Friday> is required');
const weeks = Number(arg('weeks', '10'));
const from = new Date(Date.parse(`${to}T00:00:00Z`) - (weeks - 1) * 7 * DAY).toISOString().slice(0, 10);
const capital: number = config.capitalUsd;
const riskPct: number = config.riskPerTradePct;
const slack: number = config.sizingSlackPct ?? 0;
const st = config.strategy;
const MIN_AMOUNT: Record<string, number> = { BTC: 0.01, ETH: 0.1, SOL: 10 };
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const name = (id: string, expiry: string, strike: number, type: OptionType) => {
  const d = new Date(`${expiry}T08:00:00Z`);
  return `${id}_USDC-${d.getUTCDate()}${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}-${strike}-${type === 'put' ? 'P' : 'C'}`;
};
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;

const spreads: SpreadRecord[] = [];
const markets: string[] = [];
for (const [id, m] of Object.entries(config.markets) as [MarketId, { enabled: boolean; structure?: OptionType }][]) {
  if (!m.enabled) continue;
  const type: OptionType = m.structure ?? 'put';
  let trades;
  try {
    trades = simulateWeekly(id, { type, distanceAtr: st.distanceAtr, atrDays: st.atrDays, longSteps: st.longSteps, fill: 'cross' }, from, to);
  } catch (e) {
    console.log(`${id}: no cached history (${(e as Error).message.slice(0, 60)}), skipped`);
    continue;
  }
  const riskUsd = (capital * riskPct) / 100;
  let n = 0;
  for (const t of trades) {
    const step = MIN_AMOUNT[id];
    const amount = r8(Math.floor((riskUsd * (1 - slack / 100)) / t.maxLossUsd / step + 1e-9) * step);
    if (amount < step) continue;
    n += 1;
    spreads.push({
      id: `sim-${id}-${t.entry}`,
      market: id,
      type,
      expiry: t.expiry,
      expiryMs: Date.parse(`${t.expiry}T08:00:00Z`),
      openedAt: `${t.entry}T08:05:00.000Z`,
      entrySpot: t.spot,
      shortName: name(id, t.expiry, t.shortStrike, type),
      shortStrike: t.shortStrike,
      longName: name(id, t.expiry, t.longStrike, type),
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
  console.log(`${id} ${type} spread: ${n} simulated weekly deals, settlements ${from}..${to}${trades.some((t) => t.modelled) ? ` (${trades.filter((t) => t.modelled).length} with a modelled leg)` : ''}`);
  if (n) markets.push(id);
}

// One close per day, from the first entry to the last settlement: cumulative P&L of the deals settled by then.
const closes: EquitySample[] = [];
const first = spreads.map((s) => s.openedAt.slice(0, 10)).sort()[0] ?? from;
let cum = 0;
for (let d = Date.parse(`${first}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += DAY) {
  const day = new Date(d).toISOString().slice(0, 10);
  cum += spreads.filter((s) => s.expiry === day).reduce((a, s) => a + (s.pnlUsd ?? 0), 0);
  closes.push({ t: d + DAY - 60_000, equityUsd: capital + cum, strategyUsd: cum });
}

const seed: Seed = { generatedAt: new Date().toISOString(), from: first, to, capitalUsd: capital, riskPerTradePct: riskPct, markets, spreads, closes };
writeFileSync('data/seed.json', JSON.stringify(seed));
console.log(`\ndata/seed.json: ${closes.length} daily closes, ${spreads.length} deals, cumulative P&L $${cum.toFixed(2)}`);
for (const s of spreads.sort((a, b) => a.openedAt.localeCompare(b.openedAt))) console.log(`  ${s.market} ${s.type} ${s.openedAt.slice(0, 10)} -> ${s.expiry}: ${s.shortStrike}/${s.longStrike} × ${s.openedAmount}, credit $${(s.creditUsd * s.openedAmount).toFixed(0)}, max loss $${(s.maxLossUsd * s.openedAmount).toFixed(0)}, settled ${s.settlePrice}: ${s.pnlUsd! >= 0 ? '+' : ''}${s.pnlUsd!.toFixed(2)}`);
