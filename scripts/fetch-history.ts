/**
 * Caches what the backtest needs, so it can be re-run offline and instantly:
 * the put tape for every Friday entry window, and daily settlement prices.
 *
 *   npm run history -- --from 2024-03-08 --markets BTC,ETH,SOL
 *
 * Deribit's SOL option history starts in the week of 8 March 2024, so that is
 * the earliest date at which all three coins can be compared on equal terms.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { ENTRY_HOUR_UTC, ENTRY_WINDOW_HOURS, getDeliveryPrices, getPutTape } from '../lib/history.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const from = arg('from', '2024-03-08');
const to = arg('to', new Date().toISOString().slice(0, 10));
const markets = arg('markets', 'BTC,ETH,SOL').split(',') as MarketId[];
function fridays(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const d = new Date(`${fromDate}T00:00:00Z`);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  for (; d.toISOString().slice(0, 10) <= toDate; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const exists = (p: string) => access(p).then(() => true, () => false);

for (const id of markets) {
  const market = MARKETS[id];
  if (!market) throw new Error(`Unknown market ${id}`);
  const WINDOW_MS = ENTRY_WINDOW_HOURS[id] * 3_600_000;
  const dir = `data/history/${id}`;
  await mkdir(dir, { recursive: true });

  const delivery = await getDeliveryPrices(market);
  await writeFile(`${dir}/delivery.json`, JSON.stringify(delivery));
  console.log(`${id}: ${Object.keys(delivery).length} daily settlement prices`);

  const todo: string[] = [];
  for (const date of fridays(from, to)) {
    const start = Date.parse(`${date}T${String(ENTRY_HOUR_UTC).padStart(2, '0')}:00:00Z`);
    // A window still in progress would cache an incomplete tape forever.
    if (start + WINDOW_MS > Date.now()) continue;
    if (!(await exists(`${dir}/${date}.json`))) todo.push(date);
  }
  console.log(`${id}: ${todo.length} entry windows to fetch`);

  let done = 0;
  const worker = async () => {
    for (let date = todo.shift(); date; date = todo.shift()) {
      const start = Date.parse(`${date}T${String(ENTRY_HOUR_UTC).padStart(2, '0')}:00:00Z`);
      const tape = await getPutTape(market, start, start + WINDOW_MS);
      await writeFile(`${dir}/${date}.json`, JSON.stringify(tape));
      if (++done % 10 === 0 || !todo.length) console.log(`${id}: ${done} cached (last ${date}: ${tape.length} put trades)`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
