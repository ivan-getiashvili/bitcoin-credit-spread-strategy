/**
 * Building and grading vertical credit spreads on INVERSE Bitcoin options.
 *
 * The inverse settlement is not a detail — it changes the answer to "what is my
 * maximum loss", and in the direction that hurts.
 *
 * A Deribit option pays out in BTC: a put worth (K - S) dollars at expiry
 * settles as (K - S)/S BTC. Work a bull put spread (short K1, long K2, K2 < K1)
 * through to the worst case:
 *
 *   loss in BTC  = (K1 - K2)/S - credit
 *   loss in USD  = loss_BTC x S = (K1 - K2) - credit x S
 *
 * The width is fixed in dollars, but the credit was collected in BTC — so its
 * dollar value shrinks with the very crash that puts the spread at max loss.
 * As S falls toward zero the credit contributes nothing and the dollar loss
 * approaches the FULL WIDTH, not width-minus-credit.
 *
 * A dollar-denominated spread caps risk at (width - credit). This one does not
 * quite. We report both: the textbook figure, and the honest one.
 */
import { bs } from './blackscholes.ts';
import type { Option } from './deribit.ts';

export type Spread = {
  kind: 'bull-put' | 'bear-call';
  expiry: string;
  daysToExpiry: number;
  shortLeg: string; longLeg: string;
  shortStrike: number; longStrike: number;
  widthUsd: number;
  /** Credit in BTC, taken at the price you would actually get filled. */
  creditBtc: number;
  creditUsd: number;
  /** Textbook max loss, as a dollar-settled spread would behave. */
  maxLossUsdNominal: number;
  /** Honest worst case: the BTC credit is near-worthless in a deep move. */
  maxLossUsdInverse: number;
  returnOnRiskPct: number;
  /** Chance the short strike finishes in the money, from Black-Scholes. */
  probShortItmPct: number;
  probProfitPct: number;
  shortDelta: number;
  breakevenUsd: number;
  shortIv: number | null;
  /** Worst leg's bid/ask spread as a share of its mark — the fill-quality tax. */
  spreadCostPct: number;
  minOpenInterest: number;
  underlying: number;
};

const yearsTo = (days: number) => Math.max(days, 0) / 365;

/**
 * Price the spread at the side of the book you would actually cross:
 * sell the short leg at its BID, buy the long leg at its ASK. Using marks or
 * mid prices is how a screener produces spreads that look profitable and cannot
 * be filled.
 */
function realisableCredit(short: Option, long: Option): number | null {
  if (short.bid === null || long.ask === null) return null;
  if (!(short.bid > 0)) return null;
  const credit = short.bid - long.ask;
  return credit > 0 ? credit : null;
}

function worstSpreadCostPct(short: Option, long: Option): number {
  const cost = (o: Option) => {
    if (o.bid === null || o.ask === null || !(o.mark > 0)) return 1;
    return (o.ask - o.bid) / o.mark;
  };
  return Math.max(cost(short), cost(long));
}

export function buildSpreads(options: Option[], opts: {
  minDays: number; maxDays: number;
  minCreditRatio: number;      // credit / width, e.g. 0.10
  maxShortDelta: number;       // e.g. 0.30 — how close to the money you will sell
  minOpenInterest: number;
  maxSpreadCostPct: number;    // reject illiquid legs
  minVolume24h?: number;       // a strike nobody trades has no real price
}): Spread[] {
  const out: Spread[] = [];
  const byExpiry = new Map<string, Option[]>();
  for (const o of options) {
    if (o.daysToExpiry < opts.minDays || o.daysToExpiry > opts.maxDays) continue;
    if (!byExpiry.has(o.expiry)) byExpiry.set(o.expiry, []);
    byExpiry.get(o.expiry)!.push(o);
  }

  for (const [expiry, legs] of byExpiry) {
    const t = yearsTo(legs[0].daysToExpiry);
    // Each expiry prices off its OWN forward, never a chain-wide figure.
    const fwd = legs.find((l) => l.underlying > 0)?.underlying ?? 0;
    if (!(fwd > 0)) continue;

    for (const type of ['put', 'call'] as const) {
      const side = legs.filter((o) => o.type === type).sort((a, b) => a.strike - b.strike);

      for (let i = 0; i < side.length; i++) {
        for (let j = 0; j < side.length; j++) {
          if (i === j) continue;
          // Bull put: sell the higher strike. Bear call: sell the lower.
          const short = type === 'put' ? side[Math.max(i, j)] : side[Math.min(i, j)];
          const long  = type === 'put' ? side[Math.min(i, j)] : side[Math.max(i, j)];
          if (short.strike === long.strike) continue;
          if (type === 'put' && !(long.strike < short.strike)) continue;
          if (type === 'call' && !(long.strike > short.strike)) continue;
          // Only construct each pair once.
          if (type === 'put' ? i <= j : i >= j) continue;

          // Never sell an option that is already in the money: its "credit" is
          // mostly intrinsic value, not premium, and the trade is not a credit
          // spread at all.
          if (type === 'put' && short.strike >= fwd) continue;
          if (type === 'call' && short.strike <= fwd) continue;

          // A strike with no open interest and no trades has no real price,
          // only a quote nobody has tested.
          if (short.openInterest <= 0 || long.openInterest <= 0) continue;
          if (opts.minVolume24h !== undefined &&
              (short.volume24h < opts.minVolume24h || long.volume24h < opts.minVolume24h)) continue;

          const vol = (short.markIv ?? 0) / 100;
          const g = bs(fwd, short.strike, t, vol, type);
          if (!g) continue;
          const delta = type === 'call' ? g.callDelta : Math.abs(g.putDelta);
          if (delta > opts.maxShortDelta) continue;      // too close to the money

          const creditBtc = realisableCredit(short, long);
          if (creditBtc === null) continue;

          const widthUsd = Math.abs(short.strike - long.strike);
          const creditUsd = creditBtc * fwd;
          if (creditUsd / widthUsd < opts.minCreditRatio) continue;

          const minOi = Math.min(short.openInterest, long.openInterest);
          if (minOi < opts.minOpenInterest) continue;

          const costPct = worstSpreadCostPct(short, long);
          if (costPct > opts.maxSpreadCostPct) continue;

          const maxLossUsdNominal = widthUsd - creditUsd;
          // In the deep-loss zone the BTC credit is worth far less than it is
          // today, so the dollar loss tends toward the full width.
          const maxLossUsdInverse = widthUsd - creditBtc * Math.min(long.strike, fwd);

          out.push({
            kind: type === 'put' ? 'bull-put' : 'bear-call',
            expiry,
            daysToExpiry: short.daysToExpiry,
            shortLeg: short.name, longLeg: long.name,
            shortStrike: short.strike, longStrike: long.strike,
            widthUsd,
            creditBtc, creditUsd,
            maxLossUsdNominal,
            maxLossUsdInverse,
            returnOnRiskPct: (creditUsd / Math.max(maxLossUsdInverse, 1)) * 100,
            probShortItmPct: g.probItm * 100,
            probProfitPct: (1 - g.probItm) * 100,
            shortDelta: delta,
            breakevenUsd: type === 'put'
              ? short.strike - creditUsd
              : short.strike + creditUsd,
            shortIv: short.markIv,
            spreadCostPct: costPct * 100,
            minOpenInterest: minOi,
            underlying: fwd,
          });
        }
      }
    }
  }
  return out;
}
