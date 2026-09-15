/**
 * Caches every morning's option trades, puts AND calls, for the expiries the structure
 * study needs (scripts/structure-search.ts): the dailies (up to 3 days out), the weekly
 * (6-8 days out) and the monthly (27-36 days out), strikes within 15% of the price.
 *
 *   npm run history:tapes -- --from 2024-03-08 --markets BTC,ETH
 *
 * Like fetch-daily.ts, the trades are the 08:00-10:00 UTC window after settlement, from
 * the coin-settled books (BTC-..., ETH-...); the study converts prices to dollars.
 * Output: data/history-tapes/{coin}/{date}.json plus delivery.json. Cached days are
 * skipped, so the script can be re-run to extend the range.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { getDeliveryPrices, getOptionTape } from '../lib/history.ts';
import { MARKETS, type MarketId } from '../lib/markets.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const DAY = 86_400_000;
const from = arg('from', '2024-03-08');
const to = arg('to', new Date().toISOString().slice(0, 10));
const markets = arg('markets', 'BTC,ETH').split(',') as MarketId[];
const WINDOW_MS = Number(arg('window-hours', '2')) * 3_600_000;
const MONEYNESS = Number(arg('moneyness', '0.15'));
const exists = (p: string) => access(p).then(() => true, () => false);
const wanted = (dte: number) => dte <= 3 || (dte >= 6 && dte <= 8) || (dte >= 27 && dte <= 36);

for (const id of markets) {
  const market = MARKETS[id];
  const dir = `data/history-tapes/${id}`;
  await mkdir(dir, { recursive: true });
  const delivery = await getDeliveryPrices(market);
  await writeFile(`${dir}/delivery.json`, JSON.stringify(delivery));

  const todo: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (t + 8 * 3_600_000 + WINDOW_MS > Date.now()) continue;
    if (!(await exists(`${dir}/${date}.json`))) todo.push(date);
  }
  console.log(`${id}: ${todo.length} mornings to fetch`);
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    for (let date = todo.shift(); date; date = todo.shift()) {
      const start = Date.parse(`${date}T08:00:00Z`);
      const spot = delivery[date];
      const tape = (await getOptionTape(market, start, start + WINDOW_MS, new Set(['put', 'call'])))
        .filter((x) => wanted((x.expiryMs - start) / DAY) && (!spot || Math.abs(x.strike / spot - 1) <= MONEYNESS));
      await writeFile(`${dir}/${date}.json`, JSON.stringify(tape));
      if (++done % 25 === 0 || !todo.length) console.log(`${id}: ${done} cached in ${Math.round((Date.now() - started) / 60_000)} min (last ${date}: ${tape.length} trades)`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
console.log('done');
