/**
 * Today's bull put spreads on BTC, ETH and SOL, chosen by the same rule the
 * backtest uses: market orders (long put at the ask, short put at the bid), and
 * the short strike FARTHEST from the money whose credit keeps the maximum loss
 * within `cap` times the credit.
 *
 *   npm run spreads              # Ivan's rule: risk at most $2 to make $1
 *   npm run spreads -- --cap 3
 */
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { getChain, getOrderBook } from '../lib/deribit.ts';
import { pickSpread } from '../lib/spread.ts';
import { bs } from '../lib/blackscholes.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const cap = Number(arg('cap', '2'));
const DTES = [7, 14, 28];
const WIDTHS = [0.02, 0.04, 0.06, 0.08];
const DAY = 86_400_000;
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

for (const id of Object.keys(MARKETS) as MarketId[]) {
  const market = MARKETS[id];
  const { options, spot } = await getChain(market);
  // Rule 3: a strike nobody holds has no real price.
  const puts = options.filter((o) => o.type === 'put' && o.openInterest > 0 && o.markIv);
  const expiries = [...new Set(puts.map((o) => o.expiryMs))];
  const toUsd = (p: number | null) =>
    p !== null && p > 0 ? (market.settlement === 'inverse' ? p * spot : p) : undefined;

  const rows: Record<string, string | number>[] = [];
  // The expiry nearest each target. Live runs happen on any weekday, so unlike the
  // Friday-entry backtest there is no tolerance band; dailies under two days are
  // skipped, and a target that lands on an expiry already shown is dropped.
  const chosen = new Set<number>();
  for (const dte of DTES) {
    const expiryMs = expiries
      .filter((e) => (e - Date.now()) / DAY >= 2)
      .sort((a, b) => Math.abs((a - Date.now()) / DAY - dte) - Math.abs((b - Date.now()) / DAY - dte))[0];
    if (!expiryMs || chosen.has(expiryMs)) continue;
    chosen.add(expiryMs);
    const t = (expiryMs - Date.now()) / DAY / 365;
    const legs = puts.filter((o) => o.expiryMs === expiryMs && o.mark > 0);
    // Deribit's mark is the fair price, the same reference the backtest measures fills against.
    const quotes = legs.map((o) => ({
      strike: o.strike,
      bid: toUsd(o.bid),
      ask: toUsd(o.ask),
      mid: toUsd(o.mark)!,
      iv: o.markIv! / 100,
    }));

    for (const widthPct of WIDTHS) {
      const pick = pickSpread(quotes, spot, market, { dte, widthPct, maxLossToCredit: cap });
      if (!pick) {
        rows.push({ expiry: new Date(expiryMs).toISOString().slice(0, 10), width: `${widthPct * 100}%`, short: 'none meets the rule' });
        continue;
      }
      const shortLeg = legs.find((o) => o.strike === pick.short.strike)!;
      const longLeg = legs.find((o) => o.strike === pick.long.strike)!;
      const [shortBook, longBook] = await Promise.all([getOrderBook(shortLeg.name), getOrderBook(longLeg.name)]);
      const g = bs(spot, pick.short.strike, t, pick.short.iv, 'put');
      const be = bs(spot, pick.short.strike - pick.creditUsd, t, pick.short.iv, 'put');
      const legSpread = (q: { bid?: number; ask?: number }) =>
        q.bid !== undefined && q.ask !== undefined ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100 : NaN;
      rows.push({
        expiry: new Date(expiryMs).toISOString().slice(0, 10),
        width: `${widthPct * 100}%`,
        short: pick.short.strike,
        long: pick.long.strike,
        'OTM %': fmt((1 - pick.short.strike / spot) * 100),
        delta: fmt(g ? -g.putDelta : NaN, 2),
        'credit $': fmt(pick.creditUsd, market.id === 'SOL' ? 2 : 0),
        'max loss $': fmt(pick.maxLossUsd, market.id === 'SOL' ? 2 : 0),
        'loss:credit': fmt(pick.maxLossUsd / pick.creditUsd, 2),
        'market win %': fmt(be ? (1 - be.probItm) * 100 : NaN, 0),
        'friction %': fmt((1 - pick.creditUsd / pick.midCreditUsd) * 100),
        'short bid/ask %': fmt(legSpread(pick.short)),
        'long bid/ask %': fmt(legSpread(pick.long)),
        // What a market order can take at the best price before it walks the book.
        'size @ best': `${longBook.asks[0]?.[1] ?? 0} / ${shortBook.bids[0]?.[1] ?? 0}`,
      });
    }
  }
  console.log(`\n${id} · index $${spot.toLocaleString('en-US')} · per 1 ${id} of underlying · max loss <= ${cap}x credit`);
  console.table(rows);
}
