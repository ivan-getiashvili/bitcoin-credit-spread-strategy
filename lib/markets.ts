/**
 * The three option books this strategy trades, all on Deribit.
 *
 * BTC and ETH options are INVERSE: quoted and settled in the coin itself.
 * SOL options are LINEAR: quoted and settled in USDC, so a premium of 2.5 is
 * $2.50 and the ordinary dollar spread maths holds. Deribit files its SOL book
 * under the USDC currency, which is why an earlier check that only asked for
 * "SOL" options wrongly concluded there were none.
 */
export type MarketId = 'BTC' | 'ETH' | 'SOL';

export type Market = {
  id: MarketId;
  /** `currency` parameter for Deribit's option endpoints. */
  currency: string;
  /** Instrument name prefix: BTC-13SEP26-85000-P, SOL_USDC-13SEP26-86-P. */
  prefix: string;
  settlement: 'inverse' | 'linear';
  /** Index whose 08:00 UTC value settles the options. */
  indexName: string;
};

export const MARKETS: Record<MarketId, Market> = {
  BTC: { id: 'BTC', currency: 'BTC', prefix: 'BTC', settlement: 'inverse', indexName: 'btc_usd' },
  ETH: { id: 'ETH', currency: 'ETH', prefix: 'ETH', settlement: 'inverse', indexName: 'eth_usd' },
  SOL: { id: 'SOL', currency: 'USDC', prefix: 'SOL_USDC', settlement: 'linear', indexName: 'sol_usdc' },
};

/**
 * The dollar-settled books the bot trades. Deribit lists no USDT-settled options;
 * its dollar options settle in USDC, priced per coin of underlying, so premiums,
 * risk and P&L are all plain dollar figures. (The inverse `MARKETS` above are
 * what the historical backtest was run on.)
 */
export const DOLLAR_MARKETS: Record<MarketId, Market> = {
  BTC: { id: 'BTC', currency: 'USDC', prefix: 'BTC_USDC', settlement: 'linear', indexName: 'btc_usdc' },
  ETH: { id: 'ETH', currency: 'USDC', prefix: 'ETH_USDC', settlement: 'linear', indexName: 'eth_usdc' },
  SOL: { id: 'SOL', currency: 'USDC', prefix: 'SOL_USDC', settlement: 'linear', indexName: 'sol_usdc' },
};

export type ParsedName = { expiry: string; expiryMs: number; strike: number; type: 'call' | 'put' };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * "SOL_USDC-13SEP26-87d5-P" -> its parts. Returns null for anything that is not
 * an option in this market — including BTC_USDC names when the prefix is "BTC".
 */
export function parseName(name: string, prefix: string): ParsedName | null {
  if (!name.startsWith(prefix + '-')) return null;
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(name.slice(prefix.length + 1));
  if (!m) return null;
  const [, d, mon, yy, strikeRaw, cp] = m;
  const mi = MONTHS.indexOf(mon);
  if (mi < 0) return null;
  // Deribit expiries settle at 08:00 UTC.
  const ms = Date.UTC(2000 + Number(yy), mi, Number(d), 8, 0, 0);
  return {
    expiry: new Date(ms).toISOString().slice(0, 10),
    expiryMs: ms,
    strike: Number(strikeRaw.replace('d', '.')),
    type: cp === 'C' ? 'call' : 'put',
  };
}
