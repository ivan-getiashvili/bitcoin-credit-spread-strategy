/**
 * Deribit public market data. Keyless — no account needed to read the chain.
 *
 * THE THING THAT WILL BITE YOU: Deribit BTC options are INVERSE. Every premium,
 * bid and ask is quoted in BTC, not dollars, and each contract is worth 1 BTC of
 * underlying. Verified against a live quote: BTC-13SEP26-85000-P marked
 * 0.09975858 BTC with the index at 77,289.71, and 0.09975858 x 77,289.71 =
 * $7,710 — exactly its intrinsic value of 85,000 - 77,290.
 *
 * So a "0.01 credit" is 0.01 BTC, whose dollar value moves with BTC itself.
 * Treating those numbers as dollars would understate a position by roughly five
 * orders of magnitude, and every risk figure downstream would be fiction.
 */

const BASE = 'https://www.deribit.com/api/v2/public';

async function get(path: string, params: Record<string, string> = {}, timeoutMs = 30_000): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}${qs ? '?' + qs : ''}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Deribit ${path} HTTP ${res.status}`);
  const json = await res.json();
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
  /** All premiums are in BTC. Multiply by `underlying` for dollars. */
  bid: number | null;
  ask: number | null;
  mark: number;
  markIv: number | null;   // percent
  openInterest: number;
  volume24h: number;
  underlying: number;      // USD
};

/** "BTC-13SEP26-85000-P" -> its parts. Returns null for anything unexpected. */
function parseName(name: string): { expiry: string; expiryMs: number; strike: number; type: 'call' | 'put' } | null {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(name);
  if (!m) return null;
  const [, d, mon, yy, strikeRaw, cp] = m;
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const mi = months.indexOf(mon);
  if (mi < 0) return null;
  // Deribit expiries settle at 08:00 UTC.
  const ms = Date.UTC(2000 + Number(yy), mi, Number(d), 8, 0, 0);
  return {
    expiry: new Date(ms).toISOString().slice(0, 10),
    expiryMs: ms,
    strike: Number(String(strikeRaw).replace('d', '.')),
    type: cp === 'C' ? 'call' : 'put',
  };
}

/**
 * The whole BTC option chain in one request.
 *
 * `underlying_price` is per-expiry: it is the FORWARD for that expiry, not the
 * spot. In contango the June 2027 forward sits thousands of dollars above the
 * front-month one. Taking a chain-wide maximum and calling it "spot" — which an
 * earlier version did — priced a two-hour option off a nine-month forward and
 * turned a deep in-the-money put into an apparently out-of-the-money one, with
 * $2,700 of intrinsic value reported as premium. Every option keeps its own
 * forward; `spot` below is the index, taken from the nearest expiry.
 */
export async function getChain(): Promise<{ options: Option[]; spot: number; fetchedAt: string }> {
  const rows: any[] = await get('get_book_summary_by_currency', { currency: 'BTC', kind: 'option' }, 45_000);
  const now = Date.now();
  const options: Option[] = [];
  let nearestMs = Infinity;
  let spot = 0;

  for (const r of rows) {
    const p = parseName(String(r.instrument_name));
    if (!p) continue;
    const u = Number(r.underlying_price) || 0;
    // The front expiry's forward is the closest thing to spot in this payload.
    if (u > 0 && p.expiryMs < nearestMs) { nearestMs = p.expiryMs; spot = u; }
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
      underlying: u,
    });
  }
  if (!options.length) throw new Error('Deribit returned an empty chain');
  if (!(spot > 0)) throw new Error('Deribit chain carried no usable underlying price');
  return { options, spot, fetchedAt: new Date().toISOString() };
}

/** Annualised realised volatility, percent. Deribit publishes ~2 weeks of it. */
export async function getRealisedVol(): Promise<{ points: { t: number; v: number }[]; latest: number } | null> {
  try {
    const r: [number, number][] = await get('get_historical_volatility', { currency: 'BTC' });
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
