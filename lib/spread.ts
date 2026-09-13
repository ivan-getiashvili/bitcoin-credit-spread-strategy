/**
 * Bull put spread maths, shared by the backtest, the live finder and the bot so
 * all three apply exactly the same rule.
 *
 * Every figure is dollars per unit of underlying (1 BTC, 1 ETH, 1 SOL). Inverse
 * books (BTC, ETH) pay the credit in coin, so its dollar value floats with the
 * coin; linear books (SOL) pay it in USDC.
 */
import type { Market } from './markets.ts';

/**
 * Deribit option fees per unit of underlying. Trading: 0.03% of the underlying
 * (the `taker_commission` the API reports for every option), capped at 12.5% of
 * the option's price. Delivery: 0.015% on options that finish in the money, same cap.
 */
export const FEES = { taker: 0.0003, delivery: 0.00015, capShare: 0.125 };

export type SpreadRule = {
  /** Distance between the two strikes as a share of spot (0.04 = 4%). */
  widthPct: number;
  /** Ivan's rule: 2 means risk at most $2 to make $1. */
  maxLossToCredit: number;
};

/** `bid`/`ask` are what a market order gets; `mid` is the fair price. */
export type Quote = { strike: number; bid?: number; ask?: number; mid: number; iv: number };

export const takerFee = (value: number, spot: number) => Math.min(FEES.taker * spot, FEES.capShare * value);

/** Credit and risk of selling `short` at its bid and buying `long` at its ask. */
export function economics(short: Quote, long: Quote, spot: number, market: Market) {
  const bid = short.bid!;
  const ask = long.ask!;
  const creditUsd = bid - ask - takerFee(bid, spot) - takerFee(ask, spot);
  const widthUsd = short.strike - long.strike;
  // Inverse: the credit arrives in coin, and max loss is reached at the long
  // strike, where that coin is worth less than it was at entry.
  const maxLossUsd = market.settlement === 'inverse'
    ? widthUsd - (creditUsd / spot) * long.strike
    : widthUsd - creditUsd;
  return { creditUsd, widthUsd, maxLossUsd, midCreditUsd: short.mid - long.mid };
}

/**
 * Ivan's strike rule: sell the put FARTHEST from the money whose credit still
 * keeps max loss within `maxLossToCredit` times the credit, with the long put
 * about `widthPct` of spot below it. The rule, not a guess, decides the delta.
 */
export function pickSpread(quotes: Quote[], spot: number, market: Market, rule: SpreadRule) {
  const target = rule.widthPct * spot;
  const longs = quotes.filter((q) => q.ask !== undefined);
  // Farthest from the money first: the first spread that meets the risk rule is
  // the safest one the market will pay for.
  const shorts = quotes.filter((q) => q.bid !== undefined && q.strike < spot).sort((a, b) => a.strike - b.strike);
  for (const short of shorts) {
    let long: Quote | undefined;
    for (const q of longs) {
      const w = short.strike - q.strike;
      if (w < 0.6 * target || w > 1.4 * target) continue;
      if (!long || Math.abs(w - target) < Math.abs(short.strike - long.strike - target)) long = q;
    }
    if (!long) continue;
    const e = economics(short, long, spot, market);
    if (!(e.creditUsd > 0) || !(e.midCreditUsd > 0)) continue;
    if (e.maxLossUsd / e.creditUsd > rule.maxLossToCredit) continue;
    return { short, long, ...e };
  }
  return null;
}

/** Dollar P&L at expiry per unit, including delivery fees on legs that finish in the money. */
export function pnlAtExpiry(market: Market, creditUsd: number, spot: number, k1: number, k2: number, settle: number): number {
  const intr1 = Math.max(k1 - settle, 0);
  const intr2 = Math.max(k2 - settle, 0);
  const fee = (intr: number) => (intr > 0 ? Math.min(FEES.delivery * settle, FEES.capShare * intr) : 0);
  const payoff = -intr1 + intr2 - fee(intr1) - fee(intr2);
  // Inverse: the credit was paid in coin, so at expiry it is worth coin x settle.
  const credit = market.settlement === 'inverse' ? (creditUsd / spot) * settle : creditUsd;
  return credit + payoff;
}
