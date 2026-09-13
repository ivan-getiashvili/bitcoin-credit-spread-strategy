/**
 * Caches what the daily-strategy grid search needs: every morning's put trades,
 * starting at the 08:00 UTC settlement, for expiries up to a few days out, plus the
 * daily settlement prices.
 *
 *   npm run history:daily -- --from 2024-03-08 --markets BTC,ETH
 *
 * Deribit's dollar-settled BTC_USDC options only trade in size from late 2025, so the
 * history comes from the coin-settled books (BTC-..., ETH-...), which have traded
 * hundreds of next-day puts every morning since 2024. lib/daily-backtest.ts converts
 * their prices to dollars.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { getDeliveryPrices, getPutTape } from '../lib/history.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const DAY = 86_400_000;
const from = arg('from', '2024-03-08');
const to = arg('to', new Date().toISOString().slice(0, 10));
const markets = arg('markets', 'BTC,ETH').split(',') as MarketId[];
const WINDOW_MS = Number(arg('window-hours', '2')) * 3_600_000;
const MAX_DAYS = Number(arg('max-days', '3'));

const exists = (p: string) => access(p).then(() => true, () => false);

function days(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

for (const id of markets) {
  const market = MARKETS[id];
  if (!market) throw new Error(`Unknown market ${id}`);
  const dir = `data/history-daily/${id}`;
  await mkdir(dir, { recursive: true });

  const delivery = await getDeliveryPrices(market);
  await writeFile(`${dir}/delivery.json`, JSON.stringify(delivery));
  console.log(`${id}: ${Object.keys(delivery).length} daily settlement prices`);

  const todo: string[] = [];
  for (const date of days(from, to)) {
    const start = Date.parse(`${date}T08:00:00Z`);
    // A window still in progress would cache an incomplete tape forever.
    if (start + WINDOW_MS > Date.now()) continue;
    if (!(await exists(`${dir}/${date}.json`))) todo.push(date);
  }
  console.log(`${id}: ${todo.length} mornings to fetch`);

  let done = 0;
  const worker = async () => {
    for (let date = todo.shift(); date; date = todo.shift()) {
      const start = Date.parse(`${date}T08:00:00Z`);
      const tape = (await getPutTape(market, start, start + WINDOW_MS)).filter((x) => x.expiryMs - start <= MAX_DAYS * DAY);
      await writeFile(`${dir}/${date}.json`, JSON.stringify(tape));
      if (++done % 50 === 0 || !todo.length) console.log(`${id}: ${done} cached (last ${date}: ${tape.length} near-expiry put trades)`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
console.log('done');
