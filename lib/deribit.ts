/**
 * Deribit public market data. Keyless — no account needed to read the chain.
 *
 * THE THING THAT WILL BITE YOU: Deribit BTC and ETH options are INVERSE. Every
 * premium, bid and ask is quoted in the coin, not dollars, and each contract is
 * worth 1 coin of underlying. Verified against a live quote: BTC-13SEP26-85000-P
 * marked 0.09975858 BTC with the index at 77,289.71, and 0.09975858 x 77,289.71 =
 * $7,710 — exactly its intrinsic value of 85,000 - 77,290.
 *
 * So a "0.01 credit" is 0.01 BTC, whose dollar value moves with BTC itself.
 * Treating those numbers as dollars would understate a position by roughly five
 * orders of magnitude, and every risk figure downstream would be fiction.
 *
 * SOL options (SOL_USDC-...) are the opposite: LINEAR, quoted in USDC per SOL,
 * with one contract covering 10 SOL. See lib/markets.ts.
 *
 * Every function takes an optional API base, so the bot reads the books of the
 * exchange it trades on.
 */
import { MARKETS, parseName, type Market } from './markets.ts';

export const MAINNET = 'https://www.deribit.com/api/v2';
export const TESTNET = 'https://test.deribit.com/api/v2';

async function get(path: string, params: Record<string, string> = {}, timeoutMs = 30_000, base = MAINNET): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base}/public/${path}${qs ? '?' + qs : ''}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Deribit ${path} HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.error) throw new Error(`Deribit ${path}: ${JSON.stringify(json.error).slice(0, 200)}`);
  return json.result;
}

export type Option = {
  name: string;
  strike: number;
  expiry: string;          // ISO date
  expiryMs: number;
  daysToExpiry: number;
  type: 'call' | 'put';
  /** Premiums in the quote currency: the coin for inverse books, USDC for linear. */
  bid: number | null;
  ask: number | null;
  mark: number;
  markIv: number | null;   // percent
  openInterest: number;
  volume24h: number;
  /** This expiry's FORWARD price, USD. */
  underlying: number;
  /** Spot index, USD — the price the option settles against. */
  index: number;
};

/**
 * A whole option chain in one request.
 *
 * `underlying_price` is per-expiry: it is the FORWARD for that expiry, not the
 * spot. In contango the June 2027 forward sits thousands of dollars above the
 * front-month one. Taking a chain-wide maximum and calling it "spot" — which an
 * earlier version did — priced a two-hour option off a nine-month forward and
 * turned a deep in-the-money put into an apparently out-of-the-money one, with
 * $2,700 of intrinsic value reported as premium. Every option keeps its own
 * forward; `spot` is the settlement index, which is the same for every row.
 */
export async function getChain(market: Market = MARKETS.BTC, base = MAINNET): Promise<{ options: Option[]; spot: number; fetchedAt: string }> {
  return chainFromSummaries(await getBookSummaries(market.currency, base), market);
}

/** Every option book of a settlement currency in one request (~1.4 MB for USDC). Several coins can share one read. */
export async function getBookSummaries(currency: string, base = MAINNET): Promise<unknown[]> {
  return get('get_book_summary_by_currency', { currency, kind: 'option' }, 45_000, base);
}

/** One coin's chain out of a currency's book summaries. */
export function chainFromSummaries(summaries: unknown[], market: Market): { options: Option[]; spot: number; fetchedAt: string } {
  const rows = summaries as any[];
  const now = Date.now();
  const options: Option[] = [];
  let spot = 0;

  for (const r of rows) {
    const p = parseName(String(r.instrument_name), market.prefix);
    if (!p) continue;
    const index = Number(r.estimated_delivery_price) || 0;
    if (index > 0) spot = index;
    options.push({
      name: r.instrument_name,
      strike: p.strike,
      expiry: p.expiry,
      expiryMs: p.expiryMs,
      daysToExpiry: (p.expiryMs - now) / 86_400_000,
      type: p.type,
      bid: r.bid_price ?? null,
      ask: r.ask_price ?? null,
      mark: Number(r.mark_price) || 0,
      markIv: r.mark_iv ?? null,
      openInterest: Number(r.open_interest) || 0,
      volume24h: Number(r.volume) || 0,
      underlying: Number(r.underlying_price) || 0,
      index,
    });
  }
  if (!options.length) throw new Error(`Deribit returned an empty ${market.id} chain`);
  if (!(spot > 0)) throw new Error(`Deribit ${market.id} chain carried no usable index price`);
  return { options, spot, fetchedAt: new Date().toISOString() };
}

export type Book = {
  /** [price, amount] levels, best first. Prices in the quote currency, amounts in the underlying coin. */
  bids: [number, number][];
  asks: [number, number][];
  /** Deribit's fair price for the option, quote currency. */
  mark: number;
  /** Spot index, USD. */
  index: number;
};

export async function getOrderBook(name: string, depth = 5, base = MAINNET): Promise<Book> {
  const r = await get('get_order_book', { instrument_name: name, depth: String(depth) }, 30_000, base);
  return { bids: r.bids ?? [], asks: r.asks ?? [], mark: Number(r.mark_price) || 0, index: Number(r.index_price) || 0 };
}

export type InstrumentSpec = {
  name: string;
  /** Smallest price step, quote currency. */
  tickSize: number;
  /** Coarser steps that apply from `above` upward (e.g. 0.0005 BTC above 0.005 BTC). */
  tickSteps: { above: number; tick: number }[];
  /** Smallest order, in units of the underlying. */
  minAmount: number;
  contractSize: number;
};

function toSpec(r: any): InstrumentSpec {
  return {
    name: r.instrument_name,
    tickSize: Number(r.tick_size),
    tickSteps: (r.tick_size_steps ?? [])
      .map((s: any) => ({ above: Number(s.above_price), tick: Number(s.tick_size) }))
      .sort((a: { above: number }, b: { above: number }) => a.above - b.above),
    minAmount: Number(r.min_trade_amount),
    contractSize: Number(r.contract_size),
  };
}

/** Every instrument of a coin (the full list is megabytes; prefer getInstrumentSpec). */
export async function getInstrumentSpecs(market: Market, base = MAINNET): Promise<Map<string, InstrumentSpec>> {
  const rows: any[] = await get('get_instruments', { currency: market.currency, kind: 'option' }, 30_000, base);
  const out = new Map<string, InstrumentSpec>();
  for (const r of rows) {
    if (!parseName(String(r.instrument_name), market.prefix)) continue;
    out.set(r.instrument_name, toSpec(r));
  }
  return out;
}

/** One instrument's tick size and minimum order, in a small request. */
export async function getInstrumentSpec(name: string, base = MAINNET): Promise<InstrumentSpec> {
  const r = await get('get_instrument', { instrument_name: name }, 20_000, base);
  if (!r?.instrument_name) throw new Error(`Deribit has no instrument ${name}`);
  return toSpec(r);
}

/** Put a price on the instrument's tick grid, rounding down (for buys) or up (for sells). */
export function toTick(price: number, spec: InstrumentSpec, direction: 'down' | 'up'): number {
  let tick = spec.tickSize;
  for (const s of spec.tickSteps) if (price >= s.above) tick = s.tick;
  const steps = price / tick;
  const k = direction === 'down' ? Math.floor(steps + 1e-9) : Math.ceil(steps - 1e-9);
  return Number((k * tick).toFixed(10));
}

/** The most recent daily 08:00 UTC settlement prices, date -> price. */
export async function getRecentDeliveryPrices(indexName: string, count = 60, base = MAINNET): Promise<Record<string, number>> {
  const r = await get('get_delivery_prices', { index_name: indexName, offset: '0', count: String(count) }, 30_000, base);
  const out: Record<string, number> = {};
  for (const d of r.data ?? []) out[d.date] = d.delivery_price;
  return out;
}

/** Annualised realised volatility, percent. Deribit publishes ~2 weeks of it. */
export async function getRealisedVol(currency = 'BTC'): Promise<{ points: { t: number; v: number }[]; latest: number } | null> {
  try {
    const r: [number, number][] = await get('get_historical_volatility', { currency });
    const points = r.map(([t, v]) => ({ t, v }));
    return { points, latest: points.at(-1)?.v ?? 0 };
  } catch { return null; }
}

/** Per-instrument greeks. One request each, so only ask for what you need. */
export async function getGreeks(name: string): Promise<{ delta: number; gamma: number; vega: number; theta: number } | null> {
  try {
    const r = await get('ticker', { instrument_name: name });
    return r?.greeks ?? null;
  } catch { return null; }
}
