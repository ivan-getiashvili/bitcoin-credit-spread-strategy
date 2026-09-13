/**
 * Deribit's historical tape, for backtesting with prices people actually paid.
 *
 * There is no free history of option order books, but every trade records which
 * side started it. When the taker BOUGHT, the trade executed at the ask; when the
 * taker SOLD, it executed at the bid. Those are exactly the prices a market order
 * gets. So the backtest fills its long leg from taker buys and its short leg from
 * taker sells, instead of inventing a bid/ask from a model.
 */
import { parseName, type Market, type MarketId } from './markets.ts';

const HISTORY = 'https://history.deribit.com/api/v2/public';
const LIVE = 'https://www.deribit.com/api/v2/public';

/**
 * Entries happen on Fridays, starting at the 08:00 UTC settlement. The window is
 * how long we collect trades to learn what the market paid. BTC and ETH trade
 * hundreds of puts in three hours; SOL trades a few dozen, so it needs the day.
 */
export const ENTRY_HOUR_UTC = 8;
export const ENTRY_WINDOW_HOURS: Record<MarketId, number> = { BTC: 3, ETH: 3, SOL: 24 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(base: string, path: string, params: Record<string, string>): Promise<any> {
  const url = `${base}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    let json: any;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      json = await res.json();
    } catch (e) {
      // Network failure or a non-JSON body: worth another try.
      if (attempt >= 5) throw e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok && !json.error) return json.result;
    const retryable = res.status === 429 || res.status >= 500 || json?.error?.code === 10028;
    if (!retryable || attempt >= 5) {
      throw new Error(`Deribit ${path} HTTP ${res.status}: ${JSON.stringify(json?.error ?? '').slice(0, 200)}`);
    }
    await sleep(500 * 2 ** attempt);
  }
}

export type TapeTrade = {
  t: number;
  name: string;
  strike: number;
  expiryMs: number;
  /** Premium in the option's quote currency: coin for inverse, USDC for linear. */
  price: number;
  /** Deribit's mark for the option at the moment of the trade, same units as `price`. */
  mark: number;
  /** Implied volatility of this trade's price, percent. */
  iv: number;
  /** USD index at the moment of the trade. */
  index: number;
  /** The TAKER's side. 'buy' filled at the ask, 'sell' filled at the bid. */
  side: 'buy' | 'sell';
  amount: number;
};

/** Every ordinary put trade in a market between two timestamps. */
export async function getPutTape(market: Market, startMs: number, endMs: number): Promise<TapeTrade[]> {
  const out: TapeTrade[] = [];
  const seen = new Set<string>();
  let from = startMs;
  for (;;) {
    const r = await call(HISTORY, 'get_last_trades_by_currency_and_time', {
      currency: market.currency,
      kind: 'option',
      start_timestamp: String(from),
      end_timestamp: String(endMs),
      count: '1000',
      sorting: 'asc',
    });
    const trades: any[] = r.trades ?? [];
    let fresh = 0;
    for (const x of trades) {
      if (seen.has(x.trade_id)) continue;
      seen.add(x.trade_id);
      fresh++;
      // Block trades and combo legs are negotiated off the book, and liquidations
      // are forced. None of them is a price a market order could have got.
      if (x.block_trade_id || x.combo_id || x.liquidation) continue;
      const p = parseName(String(x.instrument_name), market.prefix);
      if (!p || p.type !== 'put') continue;
      out.push({
        t: x.timestamp,
        name: x.instrument_name,
        strike: p.strike,
        expiryMs: p.expiryMs,
        price: x.price,
        mark: x.mark_price,
        iv: x.iv,
        index: x.index_price,
        side: x.direction,
        amount: x.amount,
      });
    }
    if (!r.has_more || !trades.length) break;
    const last = trades[trades.length - 1].timestamp;
    // Resume AT the last timestamp so trades sharing it are not skipped; step past
    // it only when a whole page was already seen, or the loop would never end.
    from = fresh ? last : last + 1;
  }
  return out;
}

/** Daily 08:00 UTC settlement prices, date -> price. They settle expiries and feed the regime filter. */
export async function getDeliveryPrices(market: Market): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let offset = 0; ; ) {
    const r = await call(LIVE, 'get_delivery_prices', {
      index_name: market.indexName,
      offset: String(offset),
      count: '1000',
    });
    const rows: any[] = r.data ?? [];
    for (const d of rows) out[d.date] = d.delivery_price;
    offset += rows.length;
    if (!rows.length || offset >= r.records_total) break;
  }
  return out;
}
