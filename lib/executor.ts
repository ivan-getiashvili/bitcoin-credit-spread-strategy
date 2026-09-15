/**
 * Ivan's daily put spread, traded with limit orders only.
 *
 * Strategy: at the start of each Deribit options day (just after the 08:00 UTC
 * settlement), on each coin that is switched on,
 *   1. buy the put at the SECOND strike below the price,
 *   2. then sell the put at the FIRST strike below the price,
 * on the nearest expiry at least `minHoursToExpiry` away (normally the next day's),
 * sized so the whole spread can lose at most a set share of the account.
 *
 * Execution rules:
 *   - Every order is a post-only LIMIT order at the mid (or a set share toward the
 *     other side, if Ivan allows it). Nothing crosses the spread.
 *   - The long put is bought first; the short is offered only for as many as were
 *     bought, so the account is never short an uncovered put.
 *   - The short is never offered below the price at which the spread's max loss
 *     would exceed its risk budget, given what the long actually cost.
 *   - Each leg has a time limit. A long that does not fill is cancelled and nothing
 *     is held; a short that does not fill leaves only the long put.
 *   - Closing reverses the order: buy the short back first, then sell the long.
 *
 * The work is a resumable job saved after every step, so a restart picks up the
 * same exchange orders. P&L is kept as cash in the option's quote currency, which
 * for Deribit's USDC options is simply dollars.
 */
import { bs } from './blackscholes.ts';
import type { Broker, OrderView, Side } from './broker.ts';
import { toTick, type Book, type InstrumentSpec, type Option } from './deribit.ts';
import type { Market, MarketId } from './markets.ts';
import { FEES } from './spread.ts';

const HOUR = 3_600_000;
const EPS = 1e-9;
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;

export type MarketSettings = {
  /** Trade this coin unless it is switched off on the dashboard. */
  enabled: boolean;
  /** Skip expiries closer than this. At the 08:05 UTC entry the next daily is ~24 hours away. */
  minHoursToExpiry: number;
};

export type ExecSettings = {
  /** How often a resting order is moved to follow the mid, seconds. */
  repriceSeconds: number;
  /** How far past the mid toward the other side an order may go, as % of the half-spread. 0 keeps it at the mid. */
  maxConcessionPct: number;
  /** Time allowed for the long put to fill on entry, minutes. */
  buyLongMinutes: number;
  /** Time allowed for the short put to fill on entry, minutes. */
  sellShortMinutes: number;
  /** Time allowed for each leg when closing, minutes. */
  exitLegMinutes: number;
  /**
   * A leg that has not filled after its minutes at the mid is re-placed at the other side of
   * the book (the ask when buying, the bid when selling), as a taker, for this many more
   * minutes. Still within the risk budget: a price the budget forbids rests at the budget's
   * limit instead. 0 never takes.
   */
  takeMinutes?: number;
  /**
   * If the short put still does not fill, the long puts bought are sold back rather than
   * held: at the mid for this many minutes, then at the bid for `takeMinutes`. 0 keeps them
   * instead, as "long-only".
   */
  unwindMinutes?: number;
};

export type Plan = {
  market: MarketId;
  expiry: string;
  expiryMs: number;
  hoursToExpiry: number;
  spot: number;
  shortName: string;
  shortStrike: number;
  /** Mid price, quote currency. */
  shortMid: number;
  longName: string;
  longStrike: number;
  longMid: number;
  /** Per unit of underlying, dollars, at mid prices after fees. */
  creditUsd: number;
  maxLossUsd: number;
  lossToCredit: number;
  /** How far below the price the sold put sits, percent. */
  distancePct: number;
  /** The market's own odds of finishing above breakeven. */
  marketWinPct: number;
};

export type Fill = { t: string; orderId: string; side: Side; instrument: string; amount: number; price: number };

export type SpreadRecord = {
  id: string;
  market: MarketId;
  expiry: string;
  expiryMs: number;
  openedAt: string;
  /** Spot index when the entry started. */
  entrySpot: number;
  shortName: string;
  shortStrike: number;
  longName: string;
  longStrike: number;
  plannedAmount: number;
  /** The most the whole spread may lose, dollars, set from the account value at entry. */
  riskUsd: number;
  /** Account value when the entry started, dollars. */
  accountUsdAtEntry: number;
  /** Smallest credit per unit, quote currency, that keeps the spread's max loss within `riskUsd`. */
  minCreditQuote: number;
  /** Collateral the exchange quoted for this entry when it started, dollars. */
  marginUsd?: number;
  /** Open short puts, each covered by a long put. */
  amount: number;
  /** Long puts held beyond the open shorts: not yet sold against, or freed by a buy-back. */
  spareLong: number;
  /** Short puts sold on entry: the size the spread opened at. */
  openedAmount: number;
  /** Premiums received minus premiums paid minus fees, in the quote currency. */
  cashQuote: number;
  fills: Fill[];
  /** Per unit, at the prices actually filled on entry. */
  creditUsd: number;
  maxLossUsd: number;
  lossToCredit: number;
  /** `unwound`: the short put never filled and the long puts were sold back; only fees and slippage were lost. */
  status: 'opening' | 'open' | 'long-only' | 'closing' | 'closed' | 'settled' | 'cancelled' | 'unwound';
  note?: string;
  closedAt?: string;
  settlePrice?: number;
  /** Realised P&L in dollars, once closed or settled. */
  pnlUsd?: number;
};

export type Phase = 'buy-long' | 'sell-short' | 'buy-short' | 'sell-long' | 'done';

export type Job = {
  id: string;
  kind: 'entry' | 'exit';
  market: MarketId;
  spreadId: string;
  phase: Phase;
  phaseStartedAt: number;
  /** Filled so far in this phase, across any re-placed orders. */
  phaseFilled: number;
  /** The resting order; its fills are already booked against the spread. */
  order?: OrderView & { repricedAt: number };
  /** Label of an order being placed. If the bot stops mid-request, the next step looks it up. */
  pendingLabel?: string;
  /** At the other side of the book as a taker, after the mid did not fill in time. */
  taking?: boolean;
  seq: number;
};

/** An entry job selling its long puts back because the short put did not fill. */
const unwinding = (job: Job) => job.kind === 'entry' && job.phase === 'sell-long';

export type JobContext = {
  broker: Broker;
  market: Market;
  exec: ExecSettings;
  book: (name: string) => Promise<Book>;
  spec: (name: string) => InstrumentSpec | undefined;
  /** Latest spot index for the market, dollars. */
  index: () => number;
  now: () => number;
  save: () => void;
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /** Sizing headroom under the risk budget, percent (see BotConfig.sizingSlackPct). */
  sizingSlackPct?: number;
};

const inverse = (m: Market) => m.settlement === 'inverse';
export const toUsd = (m: Market, quote: number, index: number) => (inverse(m) ? quote * index : quote);
/** Fee per unit in the quote currency: 0.03% of the underlying, capped at 12.5% of the price. Maker and taker alike. */
export const feeQuote = (m: Market, price: number, index: number) =>
  Math.min(inverse(m) ? FEES.taker : FEES.taker * index, FEES.capShare * price);
const midOf = (bid: number | null | undefined, ask: number | null | undefined, mark: number) =>
  bid && ask && bid > 0 && ask > 0 ? (bid + ask) / 2 : mark;
const px = (x: number) => `${+x.toFixed(6)}`;

/** Today's spread: buy the put at the second strike below the price, sell the put at the first. */
export function planDailySpread(market: Market, chain: { options: Option[]; spot: number }, s: MarketSettings, now = Date.now()): { plan: Plan } | { skip: string } {
  const spot = chain.spot;
  const puts = chain.options.filter((o) => o.type === 'put' && o.mark > 0);
  const hours = (e: number) => (e - now) / HOUR;
  const expiryMs = [...new Set(puts.map((o) => o.expiryMs))].filter((e) => hours(e) >= s.minHoursToExpiry).sort((a, b) => a - b)[0];
  if (!expiryMs) return { skip: `no expiry at least ${s.minHoursToExpiry} hours away` };

  const below = puts.filter((o) => o.expiryMs === expiryMs && o.strike < spot).sort((a, b) => b.strike - a.strike);
  const [short, long] = below;
  if (!short || !long) return { skip: 'fewer than two strikes below the price on this expiry' };

  const shortMid = midOf(short.bid, short.ask, short.mark);
  const longMid = midOf(long.bid, long.ask, long.mark);
  const credit = shortMid - longMid - feeQuote(market, shortMid, spot) - feeQuote(market, longMid, spot);
  const width = short.strike - long.strike;
  const creditUsd = toUsd(market, credit, spot);
  const maxLossUsd = inverse(market) ? width - credit * long.strike : width - credit;
  if (!(creditUsd > 0)) return { skip: `the ${short.strike}/${long.strike} spread pays nothing after fees at mid prices` };

  const t = hours(expiryMs) / (24 * 365);
  const be = short.markIv ? bs(spot, short.strike - creditUsd, t, short.markIv / 100, 'put') : null;
  return {
    plan: {
      market: market.id,
      expiry: short.expiry,
      expiryMs,
      hoursToExpiry: hours(expiryMs),
      spot,
      shortName: short.name,
      shortStrike: short.strike,
      shortMid,
      longName: long.name,
      longStrike: long.strike,
      longMid,
      creditUsd,
      maxLossUsd,
      lossToCredit: maxLossUsd / creditUsd,
      distancePct: (1 - short.strike / spot) * 100,
      marketWinPct: be ? (1 - be.probItm) * 100 : NaN,
    },
  };
}

/**
 * Units of underlying that keep the whole spread's max loss within `riskUsd`, on the
 * order-size grid. 0 if none. `slackPct` sizes to a little under the budget: the orders
 * are placed at live book prices a moment after sizing at chain mids, and a spread sized
 * to the budget exactly is refused by the price floor after a few dollars of movement.
 */
export function sizeFor(plan: Plan, riskUsd: number, spec: InstrumentSpec, slackPct = 0): number {
  const step = spec.minAmount;
  const budget = riskUsd * (1 - Math.min(Math.max(slackPct, 0), 50) / 100);
  const units = Math.floor(budget / plan.maxLossUsd / step + 1e-9) * step;
  return units >= step ? r8(units) : 0;
}

export function openEntry(market: Market, plan: Plan, amount: number, riskUsd: number, accountUsd: number, now: number): { spread: SpreadRecord; job: Job } {
  const id = `${market.id}-${plan.expiry}-${now.toString(36)}`;
  const width = plan.shortStrike - plan.longStrike;
  const budgetPerUnit = riskUsd / amount;
  // Inverse: max loss = width - credit x longStrike. Linear: width - credit.
  const minCreditQuote = Math.max(0, inverse(market) ? (width - budgetPerUnit) / plan.longStrike : width - budgetPerUnit);
  const spread: SpreadRecord = {
    id,
    market: market.id,
    expiry: plan.expiry,
    expiryMs: plan.expiryMs,
    openedAt: new Date(now).toISOString(),
    entrySpot: plan.spot,
    shortName: plan.shortName,
    shortStrike: plan.shortStrike,
    longName: plan.longName,
    longStrike: plan.longStrike,
    plannedAmount: amount,
    riskUsd,
    accountUsdAtEntry: accountUsd,
    minCreditQuote,
    amount: 0,
    spareLong: 0,
    openedAmount: 0,
    cashQuote: 0,
    fills: [],
    creditUsd: 0,
    maxLossUsd: 0,
    lossToCredit: 0,
    status: 'opening',
  };
  const job: Job = { id: `${id}-entry`, kind: 'entry', market: market.id, spreadId: id, phase: 'buy-long', phaseStartedAt: now, phaseFilled: 0, seq: 0 };
  return { spread, job };
}

export function openExit(spread: SpreadRecord, now: number): Job {
  spread.status = 'closing';
  spread.note = undefined;
  return {
    id: `${spread.id}-exit-${now.toString(36)}`,
    kind: 'exit',
    market: spread.market,
    spreadId: spread.id,
    phase: spread.amount > EPS ? 'buy-short' : 'sell-long',
    phaseStartedAt: now,
    phaseFilled: 0,
    seq: 0,
  };
}

export const LEG = {
  'buy-long': { side: 'buy', leg: 'long', code: 'BL', step: 1, says: 'buying the long put' },
  'sell-short': { side: 'sell', leg: 'short', code: 'SS', step: 2, says: 'selling the short put' },
  'buy-short': { side: 'buy', leg: 'short', code: 'BS', step: 1, says: 'buying back the short put' },
  'sell-long': { side: 'sell', leg: 'long', code: 'SL', step: 2, says: 'selling the long put' },
} as const;

export function phaseLimitMs(job: Job, exec: ExecSettings): number {
  const minutes = job.taking ? exec.takeMinutes ?? 0
    : job.phase === 'buy-long' ? exec.buyLongMinutes
    : job.phase === 'sell-short' ? exec.sellShortMinutes
    : unwinding(job) ? exec.unwindMinutes ?? 0
    : exec.exitLegMinutes;
  return minutes * 60_000;
}

const instrumentOf = (job: Job, spread: SpreadRecord) =>
  job.phase !== 'done' && LEG[job.phase].leg === 'long' ? spread.longName : spread.shortName;

function phaseAmount(job: Job, spread: SpreadRecord): number {
  if (job.phase === 'buy-long') return r8(spread.plannedAmount - job.phaseFilled);
  if (job.phase === 'buy-short') return spread.amount;
  if (job.phase === 'sell-short' || job.phase === 'sell-long') return spread.spareLong;
  return 0;
}

function avgFill(spread: SpreadRecord, side: Side, instrument: string): number {
  let qty = 0;
  let value = 0;
  for (const f of spread.fills) {
    if (f.side !== side || f.instrument !== instrument) continue;
    qty += f.amount;
    value += f.amount * f.price;
  }
  return qty > 0 ? value / qty : 0;
}

const isFinished = (o: OrderView) => o.state !== 'open' || o.filled >= o.amount - EPS;

/** The limit price for this phase right now, or null if no price keeps the spread within its risk budget. */
async function targetPrice(job: Job, spread: SpreadRecord, ctx: JobContext): Promise<number | null> {
  if (job.phase === 'done') return null;
  const m = ctx.market;
  const name = instrumentOf(job, spread);
  const spec = ctx.spec(name);
  if (!spec) throw new Error(`no tick size known for ${name}`);
  const book = await ctx.book(name);
  const index = book.index || ctx.index();
  const bid = book.bids[0]?.[0];
  const ask = book.asks[0]?.[0];
  const mid = midOf(bid, ask, book.mark);
  if (!(mid > 0)) return null;

  const buying = LEG[job.phase].side === 'buy';
  // Taking goes all the way to the other side; everything else obeys the concession setting.
  const give = job.taking ? 1 : Math.min(Math.max(ctx.exec.maxConcessionPct, 0), 100) / 100;
  let price = buying ? mid + give * Math.max((ask ?? mid) - mid, 0) : mid - give * Math.max(mid - (bid ?? mid), 0);

  if (job.phase === 'buy-long') {
    // Pay at most what still leaves the minimum credit if the short sells at its mid.
    const s = await ctx.book(spread.shortName);
    const shortMid = midOf(s.bids[0]?.[0], s.asks[0]?.[0], s.mark);
    const fees = feeQuote(m, shortMid, index) + feeQuote(m, mid, index);
    let longMax = shortMid - fees - spread.minCreditQuote;
    if (longMax < toTick(mid, spec, 'down') - EPS) {
      // Prices moved against the entry since it was sized: the planned size no longer fits
      // the budget. Cut the plan to what the budget allows at today's prices and carry on,
      // rather than stop at whatever happened to fill. The budget itself never changes.
      const resized = resizeToBudget(spread, shortMid - mid - fees, spec, ctx);
      if (resized === null) return null;
      ctx.log(`${spread.market}: prices moved; the spread now fits ${resized} instead of the planned size within the $${spread.riskUsd.toFixed(2)} budget`, 'warn');
      longMax = shortMid - fees - spread.minCreditQuote;
      if (longMax < toTick(mid, spec, 'down') - EPS) return null;
    }
    price = Math.min(price, longMax);
  }
  if (job.phase === 'sell-short') {
    // Never below the price that keeps max loss within the budget, given the long's real cost.
    const longCost = avgFill(spread, 'buy', spread.longName);
    const floor = longCost + feeQuote(m, longCost, index) + feeQuote(m, Math.max(price, longCost), index) + spread.minCreditQuote;
    price = Math.max(price, floor);
  }
  const ticked = toTick(price, spec, buying ? 'down' : 'up');
  return ticked > 0 ? ticked : null;
}

/**
 * Shrink the planned size to what the risk budget allows at a credit of `creditQuote` per
 * unit (after fees), keeping what is already bought. Returns the new planned size, or null
 * if even the size already bought no longer fits, in which case nothing more is bought.
 */
function resizeToBudget(spread: SpreadRecord, creditQuote: number, spec: InstrumentSpec, ctx: JobContext): number | null {
  const m = ctx.market;
  // A spread that collects nothing is not the strategy at any size.
  if (!(creditQuote > 0)) return null;
  const width = spread.shortStrike - spread.longStrike;
  const maxLossUsd = inverse(m) ? width - creditQuote * spread.longStrike : width - creditQuote;
  if (!(maxLossUsd > 0)) return null;
  const step = spec.minAmount;
  const budget = spread.riskUsd * (1 - Math.min(Math.max(ctx.sizingSlackPct ?? 0, 0), 50) / 100);
  const units = r8(Math.floor(budget / maxLossUsd / step + 1e-9) * step);
  const bought = r8(spread.spareLong + spread.amount);
  if (units < step || units <= bought + EPS || units >= spread.plannedAmount - EPS) return null;
  spread.plannedAmount = units;
  const budgetPerUnit = spread.riskUsd / units;
  spread.minCreditQuote = Math.max(0, inverse(m) ? (width - budgetPerUnit) / spread.longStrike : width - budgetPerUnit);
  return units;
}

/** Book whatever filled since the order was last seen against the spread's holdings and cash. */
function applyFill(job: Job, spread: SpreadRecord, o: OrderView, ctx: JobContext): void {
  const before = job.order;
  const prevFilled = before?.filled ?? 0;
  const prevAvg = before?.avgPrice ?? 0;
  const d = r8(o.filled - prevFilled);
  if (d > EPS) {
    const price = (o.filled * o.avgPrice - prevFilled * prevAvg) / d;
    spread.cashQuote += (o.side === 'sell' ? d * price : -d * price) - d * feeQuote(ctx.market, price, ctx.index());
    job.phaseFilled = r8(job.phaseFilled + d);
    if (job.phase === 'buy-long') spread.spareLong = r8(spread.spareLong + d);
    if (job.phase === 'sell-short') {
      spread.amount = r8(spread.amount + d);
      spread.spareLong = r8(spread.spareLong - d);
      spread.openedAmount = r8(spread.openedAmount + d);
    }
    if (job.phase === 'buy-short') {
      spread.amount = r8(spread.amount - d);
      spread.spareLong = r8(spread.spareLong + d);
    }
    if (job.phase === 'sell-long') spread.spareLong = r8(spread.spareLong - d);
    spread.fills.push({ t: new Date(ctx.now()).toISOString(), orderId: o.orderId, side: o.side, instrument: o.instrument, amount: d, price });
    ctx.log(`${spread.market}: filled ${o.side} ${d} ${o.instrument} at ${px(price)}`);
  }
  if (before) Object.assign(before, { filled: o.filled, avgPrice: o.avgPrice, state: o.state, price: o.price });
}

function bookEntryRisk(spread: SpreadRecord, ctx: JobContext): void {
  const index = spread.entrySpot;
  const longAvg = avgFill(spread, 'buy', spread.longName);
  const shortAvg = avgFill(spread, 'sell', spread.shortName);
  const credit = shortAvg - longAvg - feeQuote(ctx.market, shortAvg, index) - feeQuote(ctx.market, longAvg, index);
  const width = spread.shortStrike - spread.longStrike;
  spread.creditUsd = toUsd(ctx.market, credit, index);
  spread.maxLossUsd = inverse(ctx.market) ? width - credit * spread.longStrike : width - credit;
  spread.lossToCredit = spread.maxLossUsd / spread.creditUsd;
}

function complete(job: Job, spread: SpreadRecord, ctx: JobContext, why: string): void {
  job.phase = 'done';
  job.order = undefined;
  job.pendingLabel = undefined;
  const m = spread.market;
  if (job.kind === 'entry') {
    if (spread.amount > EPS) {
      bookEntryRisk(spread, ctx);
      spread.status = 'open';
      spread.note = spread.spareLong > EPS
        ? `Short put filled ${spread.amount} of ${r8(spread.amount + spread.spareLong)}; ${spread.spareLong} long puts are held without a short.`
        : undefined;
      ctx.log(`${m}: spread open, ${spread.amount} × ${spread.shortStrike}/${spread.longStrike}, credit $${(spread.creditUsd * spread.amount).toFixed(2)}, max loss $${(spread.maxLossUsd * spread.amount).toFixed(2)} of a $${spread.riskUsd.toFixed(2)} budget`);
    } else if (spread.spareLong > EPS) {
      spread.status = 'long-only';
      spread.note = `Short put not sold (${why}). Holding ${spread.spareLong} long puts only, with no short exposure.`;
      ctx.log(`${m}: ${spread.note}`, 'warn');
    } else if (spread.fills.length) {
      // Bought, then sold back: no spread ever existed, only fees and slippage were paid.
      spread.status = 'unwound';
      spread.closedAt = new Date(ctx.now()).toISOString();
      spread.pnlUsd = toUsd(ctx.market, spread.cashQuote, ctx.index());
      spread.note = `Unwound: the short put did not fill, so the long puts were sold back (${why}). Cost $${(-spread.pnlUsd).toFixed(2)}.`;
      ctx.log(`${m}: ${spread.note}`, 'warn');
    } else {
      spread.status = 'cancelled';
      spread.note = `Nothing filled: ${why}.`;
      ctx.log(`${m}: entry ended with nothing filled (${why})`, 'warn');
    }
    return;
  }
  if (spread.amount <= EPS && spread.spareLong <= EPS) {
    spread.status = 'closed';
    spread.closedAt = new Date(ctx.now()).toISOString();
    spread.pnlUsd = toUsd(ctx.market, spread.cashQuote, ctx.index());
    spread.note = undefined;
    ctx.log(`${m}: spread closed, P&L $${spread.pnlUsd.toFixed(2)}`);
  } else {
    spread.status = spread.amount > EPS ? 'open' : 'long-only';
    spread.note = `Close stopped (${why}): ${spread.amount} spread and ${spread.spareLong} spare long puts remain.`;
    ctx.log(`${m}: ${spread.note}`, 'warn');
  }
}

function finishPhase(job: Job, spread: SpreadRecord, ctx: JobContext, why: string, timedOut = false): void {
  // Out of time at the mid with something left to do: the same leg again, at the other side of the book.
  if (timedOut && !job.taking && phaseAmount(job, spread) > EPS && (ctx.exec.takeMinutes ?? 0) > 0) {
    const side = LEG[job.phase as Exclude<Phase, 'done'>].side === 'buy' ? 'ask' : 'bid';
    ctx.log(`${spread.market}: ${LEG[job.phase as Exclude<Phase, 'done'>].says}: ${why}; re-placing at the ${side}`, 'warn');
    job.taking = true;
    job.phaseStartedAt = ctx.now();
    return;
  }
  const next = (phase: Phase) => {
    job.phase = phase;
    job.phaseStartedAt = ctx.now();
    job.phaseFilled = 0;
    job.taking = false;
  };
  if (job.phase === 'buy-long' && spread.spareLong > EPS) {
    if (why !== 'filled') ctx.log(`${spread.market}: long put ${why}; offering short puts against the ${spread.spareLong} bought`, 'warn');
    return next('sell-short');
  }
  // The short put did not fill: sell the long puts back rather than hold them.
  if (job.phase === 'sell-short' && spread.spareLong > EPS && (ctx.exec.unwindMinutes ?? 0) > 0) {
    ctx.log(`${spread.market}: short put ${why}; selling the ${spread.spareLong} long puts back rather than holding them`, 'warn');
    return next('sell-long');
  }
  if (job.phase === 'buy-short' && spread.spareLong > EPS) return next('sell-long');
  complete(job, spread, ctx, why);
}

async function step(job: Job, spread: SpreadRecord, ctx: JobContext): Promise<void> {
  if (job.phase === 'done') return;
  const now = ctx.now();
  const limitMs = phaseLimitMs(job, ctx.exec);
  const budget = `the $${spread.riskUsd.toFixed(2)} risk budget`;

  if (job.order) {
    let o = await ctx.broker.orderState(job.order.orderId);
    applyFill(job, spread, o, ctx);
    if (isFinished(o)) {
      job.order = undefined;
      return finishPhase(job, spread, ctx, o.state === 'filled' || o.filled >= o.amount - EPS ? 'filled' : `order ${o.state}`);
    }
    if (now - job.phaseStartedAt >= limitMs) {
      o = await ctx.broker.cancelOrder(o.orderId);
      applyFill(job, spread, o, ctx);
      job.order = undefined;
      return finishPhase(job, spread, ctx, `not filled within ${Math.round(limitMs / 60_000)} minutes${job.taking ? ' at the other side of the book' : ''}`, true);
    }
    if (now - job.order.repricedAt >= ctx.exec.repriceSeconds * 1000) {
      job.order.repricedAt = now;
      const price = await targetPrice(job, spread, ctx);
      if (price === null) {
        o = await ctx.broker.cancelOrder(o.orderId);
        applyFill(job, spread, o, ctx);
        job.order = undefined;
        return finishPhase(job, spread, ctx, `${budget} can no longer be met at mid prices`);
      }
      // The plan was cut to fit the budget: the resting order is too big now, so replace it.
      if (Math.abs(phaseAmount(job, spread) - r8(o.amount - o.filled)) > EPS) {
        o = await ctx.broker.cancelOrder(o.orderId);
        applyFill(job, spread, o, ctx);
        job.order = undefined;
        return;
      }
      if (Math.abs(price - o.price) > EPS) {
        o = await ctx.broker.editOrder(o, price);
        applyFill(job, spread, o, ctx);
        if (isFinished(o)) {
          job.order = undefined;
          return finishPhase(job, spread, ctx, o.state === 'filled' ? 'filled' : `order ${o.state}`);
        }
        ctx.log(`${spread.market}: moved limit ${o.side} ${o.instrument} to ${px(o.price)} to follow the mid`);
      }
    }
    return;
  }

  const amount = phaseAmount(job, spread);
  if (amount <= EPS) return finishPhase(job, spread, ctx, 'filled');

  if (job.pendingLabel) {
    // The bot stopped while placing this order: adopt it if the exchange has it.
    const found = await ctx.broker.orderByLabel(job.pendingLabel, ctx.market.currency);
    job.pendingLabel = undefined;
    if (found) {
      job.order = { ...found, filled: 0, avgPrice: 0, repricedAt: now };
      applyFill(job, spread, found, ctx);
      ctx.log(`${spread.market}: found order ${found.label} on the exchange after a restart`, 'warn');
      if (isFinished(found)) {
        job.order = undefined;
        return finishPhase(job, spread, ctx, found.state === 'filled' ? 'filled' : `order ${found.state}`);
      }
      return;
    }
  }

  if (now - job.phaseStartedAt >= limitMs) return finishPhase(job, spread, ctx, `not filled within ${Math.round(limitMs / 60_000)} minutes`, true);
  const price = await targetPrice(job, spread, ctx);
  if (price === null) return finishPhase(job, spread, ctx, `no price keeps the spread within ${budget} at mid prices`);
  // Pricing may have cut the plan to fit the budget, so size the order after it.
  const orderAmount = phaseAmount(job, spread);
  if (orderAmount <= EPS) return finishPhase(job, spread, ctx, 'filled');

  const leg = LEG[job.phase];
  job.seq += 1;
  const label = `${spread.id}-${leg.code}${job.seq}`;
  job.pendingLabel = label;
  ctx.save();
  // A taking order must be allowed to take liquidity; every other order only makes it.
  const placed = await ctx.broker.limitOrder(leg.side, instrumentOf(job, spread), orderAmount, price, label, ctx.market.currency, { postOnly: !job.taking });
  job.pendingLabel = undefined;
  job.order = { ...placed, filled: 0, avgPrice: 0, repricedAt: now };
  const says = unwinding(job) ? 'selling the long puts back' : leg.says;
  ctx.log(`${spread.market}: ${says}${job.taking ? ` at the ${leg.side === 'buy' ? 'ask' : 'bid'}` : ''}: limit ${placed.side} ${orderAmount} ${placed.instrument} at ${px(placed.price)}`);
  applyFill(job, spread, placed, ctx);
  if (isFinished(placed)) {
    job.order = undefined;
    return finishPhase(job, spread, ctx, placed.state === 'filled' ? 'filled' : `order ${placed.state}`);
  }
}

/** Advance a job as far as it can go now: check its order, move it, or place the next leg's order. */
export async function advanceJob(job: Job, spread: SpreadRecord, ctx: JobContext): Promise<void> {
  // Always one step; then keep stepping while there is no resting order, so a finished phase,
  // a switch to taking or a replaced order sends the next order out in the same call.
  for (let i = 0; i < 4; i++) {
    await step(job, spread, ctx);
    if (job.phase === 'done' || job.order) break;
  }
}

/** Stop a job from the dashboard: cancel its order and keep whatever is held. */
export async function stopJob(job: Job, spread: SpreadRecord, ctx: JobContext): Promise<void> {
  if (job.phase === 'done') return;
  if (job.order) {
    const o = await ctx.broker.cancelOrder(job.order.orderId);
    applyFill(job, spread, o, ctx);
  }
  complete(job, spread, ctx, 'stopped on the dashboard');
}

/** Book an expired spread at Deribit's settlement price, including delivery fees on in-the-money legs. */
export function settleSpread(market: Market, spread: SpreadRecord, settle: number): void {
  const inv = inverse(market);
  const unit = (usd: number) => (inv ? usd / settle : usd);
  const fee = (intrinsicUsd: number) =>
    intrinsicUsd > 0 ? Math.min(inv ? FEES.delivery : FEES.delivery * settle, FEES.capShare * unit(intrinsicUsd)) : 0;
  const shortIntrinsic = Math.max(spread.shortStrike - settle, 0);
  const longIntrinsic = Math.max(spread.longStrike - settle, 0);
  const longQty = spread.amount + spread.spareLong;
  spread.cashQuote += -spread.amount * (unit(shortIntrinsic) + fee(shortIntrinsic)) + longQty * (unit(longIntrinsic) - fee(longIntrinsic));
  spread.pnlUsd = toUsd(market, spread.cashQuote, settle);
  spread.settlePrice = settle;
  spread.status = 'settled';
  spread.closedAt = new Date(spread.expiryMs).toISOString();
  spread.amount = 0;
  spread.spareLong = 0;
}

/** What the spread is worth now at Deribit's marks: cash so far plus open positions, in dollars. */
export function unrealizedUsd(market: Market, spread: SpreadRecord, shortMark: number, longMark: number, index: number): number {
  const quote = spread.cashQuote + (spread.amount + spread.spareLong) * longMark - spread.amount * shortMark;
  return toUsd(market, quote, index);
}
