/**
 * Live view of an open spread: unrealised P&L at Deribit's marks (the same basis
 * the exchange uses for floating P&L), how far the price sits above the put that
 * was sold, and the market's own odds of it staying there.
 */
import { bs } from './blackscholes.ts';
import type { Option } from './deribit.ts';
import { unrealizedUsd, type SpreadRecord } from './executor.ts';
import type { Market } from './markets.ts';

const DAY = 86_400_000;
const LIVE = new Set(['opening', 'open', 'long-only', 'closing']);

export type LiveView = {
  spot: number;
  /** Price above the short strike, percent. Negative once the short put is in the money. */
  distancePct: number;
  daysLeft: number;
  unrealizedUsd: number;
  /** Unrealised P&L as a share of the spread's maximum loss. */
  unrealizedR: number;
  chanceAboveShortPct: number;
  state: 'safe' | 'watch' | 'breached';
};

export type SpreadView = SpreadRecord & { live?: LiveView };

export function viewSpread(
  market: Market,
  spread: SpreadRecord,
  chain: { options: Option[]; spot: number } | undefined,
  alertDistancePct: number,
  now = Date.now(),
): SpreadView {
  if (!chain || !LIVE.has(spread.status)) return { ...spread };
  const short = chain.options.find((o) => o.name === spread.shortName);
  const long = chain.options.find((o) => o.name === spread.longName);
  if (!short || !long) return { ...spread };

  const spot = chain.spot;
  const pnl = unrealizedUsd(market, spread, short.mark, long.mark, spot);
  const risk = spread.amount * spread.maxLossUsd;
  const daysLeft = (spread.expiryMs - now) / DAY;
  const g = short.markIv ? bs(spot, spread.shortStrike, Math.max(daysLeft, 1e-6) / 365, short.markIv / 100, 'put') : null;
  const distancePct = (spot / spread.shortStrike - 1) * 100;
  return {
    ...spread,
    live: {
      spot,
      distancePct,
      daysLeft,
      unrealizedUsd: pnl,
      unrealizedR: risk > 0 ? pnl / risk : NaN,
      chanceAboveShortPct: g ? (1 - g.probItm) * 100 : NaN,
      state: spot < spread.shortStrike ? 'breached' : distancePct < alertDistancePct ? 'watch' : 'safe',
    },
  };
}
