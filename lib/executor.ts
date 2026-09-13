/**
 * Opening, closing and settling spreads with limit orders only, under Ivan's rules.
 *
 *   1. Every order is a post-only LIMIT order at the mid (or, if Ivan allows it, a
 *      set share of the way toward the other side). It rests on the book and never
 *      crosses the spread.
 *   2. Entry buys the long put FIRST. The short put is offered only after the long
 *      has filled, and only for as many as were bought, so the account is never
 *      short an uncovered put.
 *   3. The short put is never offered below the price at which max loss would
 *      exceed `maxLossToCredit` times the credit, given what the long really cost.
 *   4. Each leg has a time limit. A long that does not fill is cancelled and nothing
 *      is held; a short that does not fill leaves only the long put, which can lose
 *      no more than was paid for it.
 *
 * Closing reverses the order: buy the short back first, then sell the long.
 *
 * The work is a resumable job, advanced a step at a time by the bot's loop and
 * saved after every step, so a restart picks up the same orders on the exchange.
 * P&L is kept as cash — premiums received minus premiums paid minus fees, in the
 * option's own currency — which is exact for inverse and linear books alike.
 */
import { bs } from './blackscholes.ts';
import type { Broker, OrderView, Side } from './broker.ts';
import { toTick, type Book, type InstrumentSpec, type Option } from './deribit.ts';
import type { Market, MarketId } from './markets.ts';
import { FEES, pickSpread, type SpreadRule } from './spread.ts';

const DAY = 86_400_000;
const EPS = 1e-9;
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;

export type MarketSettings = SpreadRule & {
  /** Target days to expiry. */
  dte: number;
  /** Size of each spread in units of the underlying (Deribit minimums: BTC 0.1, ETH 1, SOL 10). */
  amount: number;
};

export type ExecSettings = {
  /** How often a resting order is moved to follow the market, seconds. */
  repriceSeconds: number;
  /** How far past the mid toward the other side an order may go, as % of the half-spread. 0 keeps it at the mid. */
  maxConcessionPct: number;
  /** Time allowed for the long put to fill on entry, minutes. */
  buyLongMinutes: number;
  /** Time allowed for the short put to fill on entry, minutes. */
  sellShortMinutes: number;
  /** Time allowed for each leg when closing, minutes. */
  exitLegMinutes: number;
};

export type Plan = {
  market: MarketId;
  expiry: string;
  expiryMs: number;
  spot: number;
  shortName: string;
  shortStrike: number;
  shortIv: number;
  longName: string;
  longStrike: number;
  /** Per unit, dollars, at mid prices after fees. */
  creditUsd: number;
  maxLossUsd: number;
  lossToCredit: number;
  distancePct: number;
  shortDelta: number;
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
  status: 'opening' | 'open' | 'long-only' | 'closing' | 'closed' | 'settled' | 'cancelled';
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
  seq: number;
};

export type JobContext = {
  broker: Broker;
  market: Market;
  settings: MarketSettings;
  exec: ExecSettings;
  book: (name: string) => Promise<Book>;
  spec: (name: string) => InstrumentSpec | undefined;
  /** Latest spot index for the market, USD. */
  index: () => number;
  now: () => number;
  save: () => void;
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
};

const inverse = (m: Market) => m.settlement === 'inverse';
export const toUsd = (m: Market, quote: number, index: number) => (inverse(m) ? quote * index : quote);
/** Fee per unit in the quote currency: 0.03% of the underlying, capped at 12.5% of the price. Maker and taker alike. */
export const feeQuote = (m: Market, price: number, index: number) =>
  Math.min(inverse(m) ? FEES.taker : FEES.taker * index, FEES.capShare * price);
const feeCap = (m: Market, index: number) => (inverse(m) ? FEES.taker : FEES.taker * index);

/** Smallest credit per unit, in the quote currency, that keeps max loss within `cap` times the credit. */
export function minCreditQuote(m: Market, width: number, longStrike: number, cap: number, index: number): number {
  // Inverse: max loss = width - credit x longStrike, credit worth credit x index in dollars.
  return inverse(m) ? width / (cap * index + longStrike) : width / (cap + 1);
}

const midOf = (bid: number | null | undefined, ask: number | null | undefined, mark: number) =>
  bid && ask && bid > 0 && ask > 0 ? (bid + ask) / 2 : mark;
const pct = (x: number) => `${+(x * 100).toFixed(1)}%`;
const px = (x: number) => `${+x.toFixed(6)}`;

/** The spread the rule would pick right now from a chain, priced at mids, or why there is none. */
export function planEntry(market: Market, chain: { options: Option[]; spot: number }, s: MarketSettings, now = Date.now()): { plan: Plan } | { skip: string } {
  const spot = chain.spot;
  const puts = chain.options.filter((o) => o.type === 'put' && o.openInterest > 0 && o.markIv && o.mark > 0);
  const tolerance = Math.max(3, s.dte * 0.25);
  const daysTo = (e: number) => (e - now) / DAY;
  const expiryMs = [...new Set(puts.map((o) => o.expiryMs))]
    .filter((e) => daysTo(e) >= 2 && Math.abs(daysTo(e) - s.dte) <= tolerance)
    .sort((a, b) => Math.abs(daysTo(a) - s.dte) - Math.abs(daysTo(b) - s.dte))[0];
  if (!expiryMs) {
    // Deribit lists each new weekly expiry on a Friday, so outside Fridays the
    // ~4-week slot is often empty; every Friday window in the backtest had one for BTC and ETH.
    return { skip: `no expiry ${Math.round(s.dte - tolerance)}–${Math.round(s.dte + tolerance)} days out right now; Friday's new listings usually add one` };
  }

  const legs = puts.filter((o) => o.expiryMs === expiryMs);
  // Limit orders rest at the mid, so the plan is priced there.
  const quotes = legs.map((o) => {
    const mid = toUsd(market, midOf(o.bid, o.ask, o.mark), spot);
    return { strike: o.strike, bid: mid, ask: mid, mid, iv: o.markIv! / 100 };
  });
  const pick = pickSpread(quotes, spot, market, s);
  if (!pick) return { skip: `no ${pct(s.widthPct)}-wide spread pays enough at mid prices to keep max loss within ${s.maxLossToCredit}× the credit` };

  const shortLeg = legs.find((o) => o.strike === pick.short.strike)!;
  const longLeg = legs.find((o) => o.strike === pick.long.strike)!;
  const t = daysTo(expiryMs) / 365;
  const g = bs(spot, pick.short.strike, t, pick.short.iv, 'put');
  const be = bs(spot, pick.short.strike - pick.creditUsd, t, pick.short.iv, 'put');
  return {
    plan: {
      market: market.id,
      expiry: shortLeg.expiry,
      expiryMs,
      spot,
      shortName: shortLeg.name,
      shortStrike: shortLeg.strike,
      shortIv: pick.short.iv,
      longName: longLeg.name,
      longStrike: longLeg.strike,
      creditUsd: pick.creditUsd,
      maxLossUsd: pick.maxLossUsd,
      lossToCredit: pick.maxLossUsd / pick.creditUsd,
      distancePct: (1 - shortLeg.strike / spot) * 100,
      shortDelta: g ? -g.putDelta : NaN,
      marketWinPct: be ? (1 - be.probItm) * 100 : NaN,
    },
  };
}

export function openEntry(market: Market, plan: Plan, s: MarketSettings, now: number): { spread: SpreadRecord; job: Job } {
  const id = `${market.id}-${plan.expiry}-${now.toString(36)}`;
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
    plannedAmount: s.amount,
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
  const minutes = job.phase === 'buy-long' ? exec.buyLongMinutes : job.phase === 'sell-short' ? exec.sellShortMinutes : exec.exitLegMinutes;
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

/** The limit price for this phase right now, or null if no price satisfies the rule. */
async function targetPrice(job: Job, spread: SpreadRecord, ctx: JobContext): Promise<number | null> {
  if (job.phase === 'done') return null;
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
  const give = Math.min(Math.max(ctx.exec.maxConcessionPct, 0), 100) / 100;
  let price = buying ? mid + give * Math.max((ask ?? mid) - mid, 0) : mid - give * Math.max(mid - (bid ?? mid), 0);
  const width = spread.shortStrike - spread.longStrike;
  const minCredit = minCreditQuote(ctx.market, width, spread.longStrike, ctx.settings.maxLossToCredit, index);

  if (job.phase === 'buy-long') {
    // Pay at most what still leaves the minimum credit if the short sells at its mid.
    const s = await ctx.book(spread.shortName);
    const longMax = midOf(s.bids[0]?.[0], s.asks[0]?.[0], s.mark) - 2 * feeCap(ctx.market, index) - minCredit;
    if (longMax < mid) return null;
    price = Math.min(price, longMax);
  }
  if (job.phase === 'sell-short') {
    // Never below the price that keeps max loss within the cap, given the long's real cost.
    const floor = avgFill(spread, 'buy', spread.longName) + 2 * feeCap(ctx.market, index) + minCredit;
    price = Math.max(price, floor);
  }
  const ticked = toTick(price, spec, buying ? 'down' : 'up');
  return ticked > 0 ? ticked : null;
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
      ctx.log(`${m}: spread open, ${spread.amount} × ${spread.shortStrike}/${spread.longStrike}, credit $${(spread.creditUsd * spread.amount).toFixed(2)}, max loss $${(spread.maxLossUsd * spread.amount).toFixed(2)} (${spread.lossToCredit.toFixed(2)}×)`);
    } else if (spread.spareLong > EPS) {
      spread.status = 'long-only';
      spread.note = `Short put not sold (${why}). Holding ${spread.spareLong} long puts only, with no short exposure.`;
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

function finishPhase(job: Job, spread: SpreadRecord, ctx: JobContext, why: string): void {
  const next = (phase: Phase) => {
    job.phase = phase;
    job.phaseStartedAt = ctx.now();
    job.phaseFilled = 0;
  };
  if (job.phase === 'buy-long' && spread.spareLong > EPS) {
    if (why !== 'filled') ctx.log(`${spread.market}: long put ${why}; offering short puts against the ${spread.spareLong} bought`, 'warn');
    return next('sell-short');
  }
  if (job.phase === 'buy-short' && spread.spareLong > EPS) return next('sell-long');
  complete(job, spread, ctx, why);
}

async function step(job: Job, spread: SpreadRecord, ctx: JobContext): Promise<void> {
  if (job.phase === 'done') return;
  const now = ctx.now();
  const limitMs = phaseLimitMs(job, ctx.exec);

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
      return finishPhase(job, spread, ctx, `not filled within ${Math.round(limitMs / 60_000)} minutes`);
    }
    if (now - job.order.repricedAt >= ctx.exec.repriceSeconds * 1000) {
      job.order.repricedAt = now;
      const price = await targetPrice(job, spread, ctx);
      if (price === null) {
        o = await ctx.broker.cancelOrder(o.orderId);
        applyFill(job, spread, o, ctx);
        job.order = undefined;
        return finishPhase(job, spread, ctx, `the ${ctx.settings.maxLossToCredit}:1 rule is no longer met at mid prices`);
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

  if (now - job.phaseStartedAt >= limitMs) return finishPhase(job, spread, ctx, `not filled within ${Math.round(limitMs / 60_000)} minutes`);
  const price = await targetPrice(job, spread, ctx);
  if (price === null) return finishPhase(job, spread, ctx, `no price meets the ${ctx.settings.maxLossToCredit}:1 rule at mid prices`);

  const leg = LEG[job.phase];
  job.seq += 1;
  const label = `${spread.id}-${leg.code}${job.seq}`;
  job.pendingLabel = label;
  ctx.save();
  const placed = await ctx.broker.limitOrder(leg.side, instrumentOf(job, spread), amount, price, label, ctx.market.currency);
  job.pendingLabel = undefined;
  job.order = { ...placed, filled: 0, avgPrice: 0, repricedAt: now };
  ctx.log(`${spread.market}: ${leg.says}: limit ${placed.side} ${amount} ${placed.instrument} at ${px(placed.price)}`);
  applyFill(job, spread, placed, ctx);
  if (isFinished(placed)) {
    job.order = undefined;
    return finishPhase(job, spread, ctx, placed.state === 'filled' ? 'filled' : `order ${placed.state}`);
  }
}

/** Advance a job as far as it can go now: check its order, move it, or place the next leg's order. */
export async function advanceJob(job: Job, spread: SpreadRecord, ctx: JobContext): Promise<void> {
  // A finished phase hands over straight away, so the next leg's order goes out in the same step.
  for (let i = 0; i < 4 && job.phase !== 'done'; i++) {
    const phase = job.phase;
    await step(job, spread, ctx);
    if (job.phase === phase || job.order) break;
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
