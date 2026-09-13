/**
 * Black-Scholes, used only for probabilities and delta.
 *
 * Deribit publishes greeks, but one request per instrument means ~950 requests
 * to grade a whole chain. The closed form is instant and, for delta and
 * probability-of-touch, close enough to Deribit's own numbers to make the
 * round trip pointless. Prices always come from the exchange, never from here —
 * a model price is an opinion, and the bid is a fact.
 */

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

export type BS = { d1: number; d2: number; callDelta: number; putDelta: number; probItm: number };

/**
 * @param s spot, @param k strike, @param t years to expiry, @param vol annualised (0.55 = 55%)
 * `probItm` is the risk-neutral chance of finishing in the money for THIS option type.
 */
export function bs(s: number, k: number, t: number, vol: number, type: 'call' | 'put', r = 0): BS | null {
  if (!(s > 0 && k > 0 && t > 0 && vol > 0)) return null;
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + (vol * vol) / 2) * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const callDelta = normCdf(d1);
  const putDelta = callDelta - 1;
  // N(d2) is the chance a call expires ITM; 1 - N(d2) for a put.
  const probItm = type === 'call' ? normCdf(d2) : 1 - normCdf(d2);
  return { d1, d2, callDelta, putDelta, probItm };
}
