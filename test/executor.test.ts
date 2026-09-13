/**
 * The daily spread and its limit-order execution, checked against a fake exchange
 * whose books, resting orders and fills the tests control. These are the promises
 * the bot makes with money: first and second strikes below the price, 2% of the
 * account at risk for the whole spread, limit orders at the mid only, long put
 * first, never more short than long, and nothing left uncovered when a leg does
 * not fill.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { putPrice } from '../lib/blackscholes.ts';
import type { Broker, OrderView, Side } from '../lib/broker.ts';
import { toTick, type Book, type InstrumentSpec, type Option } from '../lib/deribit.ts';
import { advanceJob, openEntry, openExit, planDailySpread, settleSpread, sizeFor, stopJob, type ExecSettings, type JobContext, type Plan } from '../lib/executor.ts';
import { DOLLAR_MARKETS } from '../lib/markets.ts';

const BTC = DOLLAR_MARKETS.BTC;
const SHORT = 'BTC_USDC-14SEP26-76500-P';
const LONG = 'BTC_USDC-14SEP26-76000-P';
const INDEX = 76764;
const FEE_CAP = 0.0003 * INDEX; // $23.0292 per BTC per leg, unless 12.5% of the price is lower
// BTC_USDC on Deribit: 5 USDC tick (20 above 1,000), 0.01 BTC minimum order.
const SPEC: InstrumentSpec = { name: 'test', tickSize: 5, tickSteps: [{ above: 1000, tick: 20 }], minAmount: 0.01, contractSize: 1 };
const exec: ExecSettings = { repriceSeconds: 20, maxConcessionPct: 0, buyLongMinutes: 20, sellShortMinutes: 60, exitLegMinutes: 30 };

// Mids: short put $262.50, long put $137.50, strikes $500 apart. After fees the
// spread collects $84.78 per BTC and can lose $415.22, so $2,000 of risk buys 4.81 BTC.
const plan: Plan = {
  market: 'BTC', expiry: '2026-09-14', expiryMs: Date.parse('2026-09-14T08:00:00Z'), hoursToExpiry: 23.9, spot: INDEX,
  shortName: SHORT, shortStrike: 76500, shortMid: 262.5, longName: LONG, longStrike: 76000, longMid: 137.5,
  creditUsd: 84.78, maxLossUsd: 415.22, lossToCredit: 4.9, distancePct: 0.34, marketWinPct: 45,
};

function books(): Record<string, Book> {
  return {
    [SHORT]: { bids: [[245, 50]], asks: [[280, 50]], mark: 262.5, index: INDEX },
    [LONG]: { bids: [[125, 50]], asks: [[150, 50]], mark: 137.5, index: INDEX },
  };
}

class FakeExchange implements Broker {
  readonly mode = 'testnet' as const;
  readonly base = 'fake';
  orders: OrderView[] = [];
  sent: string[] = [];
  books: Record<string, Book>;

  constructor(b: Record<string, Book>) {
    this.books = b;
  }

  async limitOrder(side: Side, instrument: string, amount: number, price: number, label: string): Promise<OrderView> {
    const o: OrderView = { orderId: `o${this.orders.length + 1}`, instrument, side, price, amount, filled: 0, avgPrice: 0, state: 'open', label };
    this.orders.push(o);
    this.sent.push(`${side} ${amount} ${instrument} @ ${price}`);
    return { ...o };
  }
  async editOrder(order: OrderView, price: number): Promise<OrderView> {
    const o = this.find(order.orderId);
    o.price = price;
    this.sent.push(`move ${o.instrument} @ ${price}`);
    return { ...o };
  }
  async cancelOrder(orderId: string): Promise<OrderView> {
    const o = this.find(orderId);
    if (o.state === 'open') o.state = 'cancelled';
    this.sent.push(`cancel ${o.instrument}`);
    return { ...o };
  }
  async orderState(orderId: string): Promise<OrderView> {
    return { ...this.find(orderId) };
  }
  async orderByLabel(label: string): Promise<OrderView | null> {
    const o = this.orders.find((x) => x.label === label);
    return o ? { ...o } : null;
  }
  async margins() { return { buy: 0, sell: 0 }; }
  async positions() { return []; }
  async accounts() { return []; }

  find(orderId: string): OrderView {
    return this.orders.find((o) => o.orderId === orderId)!;
  }

  /** Someone trades against our resting order on this instrument, at our limit price. */
  fill(instrument: string, amount?: number): void {
    const o = this.orders.find((x) => x.instrument === instrument && x.state === 'open');
    if (!o) throw new Error(`no resting order on ${instrument}`);
    const q = Math.min(amount ?? o.amount, o.amount - o.filled);
    o.avgPrice = (o.avgPrice * o.filled + o.price * q) / (o.filled + q);
    o.filled = Math.round((o.filled + q) * 1e8) / 1e8;
    if (o.filled >= o.amount - 1e-9) o.state = 'filled';
  }
}

function setup(b = books()) {
  const ex = new FakeExchange(b);
  let now = Date.parse('2026-09-13T08:05:00Z');
  const ctx: JobContext = {
    broker: ex, market: BTC, exec,
    book: async (n) => structuredClone(ex.books[n]),
    spec: () => SPEC,
    index: () => INDEX,
    now: () => now,
    save: () => {},
    log: () => {},
  };
  const amount = sizeFor(plan, 2000, SPEC);
  const { spread, job } = openEntry(BTC, plan, amount, 2000, 100_000, now);
  const step = async (seconds = 0) => {
    now += seconds * 1000;
    await advanceJob(job, spread, ctx);
  };
  return { ex, ctx, spread, job, step };
}

test('sizing: 2% of a $100k account buys as many units as keep the whole spread within $2,000', () => {
  assert.equal(sizeFor(plan, 2000, SPEC), 4.81);
  assert.equal(sizeFor(plan, 3, SPEC), 0);
});

test('tick grid: BTC_USDC prices round to 5 USDC below 1,000 and 20 USDC above', () => {
  assert.equal(toTick(137.5, SPEC, 'down'), 135);
  assert.equal(toTick(262.5, SPEC, 'up'), 265);
  assert.equal(toTick(1012, SPEC, 'up'), 1020);
});

test('buys the long put first, with a limit order at the mid, and offers nothing else', async () => {
  const { ex, step, spread } = setup();
  await step();
  await step(10);
  assert.deepEqual(ex.sent, [`buy 4.81 ${LONG} @ 135`]);
  assert.equal(spread.status, 'opening');
});

test('offers the short put only after the long fills, for exactly the amount bought, within the risk budget', async () => {
  const { ex, step, spread } = setup();
  await step();
  ex.fill(LONG);
  await step(5);
  assert.deepEqual(ex.sent, [`buy 4.81 ${LONG} @ 135`, `sell 4.81 ${SHORT} @ 265`]);
  assert.equal(spread.amount, 0);
  ex.fill(SHORT);
  await step(5);
  assert.equal(spread.status, 'open');
  assert.equal(spread.amount, 4.81);
  assert.equal(spread.spareLong, 0);
  assert.ok(spread.amount * spread.maxLossUsd <= spread.riskUsd, `risk ${spread.amount * spread.maxLossUsd}`);
});

test('follows the mid as the market moves, never reaching for the other side', async () => {
  const { ex, step } = setup();
  await step();
  ex.books[LONG] = { bids: [[115, 50]], asks: [[140, 50]], mark: 127.5, index: INDEX };
  await step(21);
  assert.equal(ex.sent.at(-1), `move ${LONG} @ 125`);
});

test('never offers the short put below the price that keeps max loss within the budget', async () => {
  const { ex, step } = setup();
  await step();
  ex.fill(LONG);
  ex.books[SHORT] = { bids: [[200, 50]], asks: [[220, 50]], mark: 210, index: INDEX };
  await step(5);
  // Floor: long cost 135 + fees 16.88 + 23.03 + minimum credit 84.20 = 259.10, up to the tick: 260.
  assert.equal(ex.sent.at(-1), `sell 4.81 ${SHORT} @ 260`);
});

test('buys nothing when the risk budget cannot be met at mid prices', async () => {
  const b = books();
  b[SHORT] = { bids: [[200, 50]], asks: [[220, 50]], mark: 210, index: INDEX };
  const { ex, step, spread, job } = setup(b);
  await step();
  assert.deepEqual(ex.sent, []);
  assert.equal(spread.status, 'cancelled');
  assert.equal(job.phase, 'done');
});

test('a long put that never fills is cancelled at its time limit, and no short is offered', async () => {
  const { ex, step, spread } = setup();
  await step();
  await step(20 * 60);
  assert.deepEqual(ex.sent, [`buy 4.81 ${LONG} @ 135`, `cancel ${LONG}`]);
  assert.equal(spread.status, 'cancelled');
});

test('a partly filled long put at its time limit: short puts are offered for only that many', async () => {
  const { ex, step } = setup();
  await step();
  ex.fill(LONG, 2.4);
  await step(20 * 60);
  assert.deepEqual(ex.sent, [`buy 4.81 ${LONG} @ 135`, `cancel ${LONG}`, `sell 2.4 ${SHORT} @ 265`]);
});

test('a short put that does not fill in time leaves only the long put', async () => {
  const { ex, step, spread } = setup();
  await step();
  ex.fill(LONG);
  await step(5);
  await step(60 * 60);
  assert.equal(ex.sent.at(-1), `cancel ${SHORT}`);
  assert.equal(spread.status, 'long-only');
  assert.equal(spread.spareLong, 4.81);
  assert.equal(spread.amount, 0);
});

test('closing buys the short put back first, then sells the long put, all at mids', async () => {
  const s = setup();
  await s.step();
  s.ex.fill(LONG);
  await s.step(5);
  s.ex.fill(SHORT);
  await s.step(5);
  const exit = openExit(s.spread, s.ctx.now());
  s.ex.sent.length = 0;
  await advanceJob(exit, s.spread, s.ctx);
  assert.deepEqual(s.ex.sent, [`buy 4.81 ${SHORT} @ 260`]);
  s.ex.fill(SHORT);
  await advanceJob(exit, s.spread, s.ctx);
  assert.deepEqual(s.ex.sent, [`buy 4.81 ${SHORT} @ 260`, `sell 4.81 ${LONG} @ 140`]);
  s.ex.fill(LONG);
  await advanceJob(exit, s.spread, s.ctx);
  assert.equal(s.spread.status, 'closed');
  const fees = 4.81 * (FEE_CAP + 135 * 0.125 + FEE_CAP + 140 * 0.125);
  const expected = 4.81 * (265 - 135 - 260 + 140) - fees;
  assert.ok(Math.abs(s.spread.pnlUsd! - expected) < 0.01, `pnl ${s.spread.pnlUsd} vs ${expected}`);
});

test('stopping an entry after the long filled keeps the long put and cancels the short offer', async () => {
  const { ex, ctx, step, spread, job } = setup();
  await step();
  ex.fill(LONG);
  await step(5);
  await stopJob(job, spread, ctx);
  assert.equal(ex.sent.at(-1), `cancel ${SHORT}`);
  assert.equal(spread.status, 'long-only');
});

test('after a restart mid-placement, the order is found by its label instead of being sent twice', async () => {
  const { ex, ctx, spread, job } = setup();
  job.seq = 1;
  job.pendingLabel = `${spread.id}-BL1`;
  await ex.limitOrder('buy', LONG, 4.81, 135, job.pendingLabel);
  ex.sent.length = 0;
  await advanceJob(job, spread, ctx);
  assert.deepEqual(ex.sent, []);
  assert.equal(job.order?.label, `${spread.id}-BL1`);
});

test('settlement in dollars: a win keeps the credit; a crash loses the max loss plus delivery fees', async () => {
  for (const settle of [77_000, 70_000]) {
    const { ex, step, spread } = setup();
    await step();
    ex.fill(LONG);
    await step(5);
    ex.fill(SHORT);
    await step(5);
    const maxLoss = spread.openedAmount * spread.maxLossUsd;
    const credit = spread.cashQuote;
    settleSpread(BTC, spread, settle);
    assert.equal(spread.status, 'settled');
    if (settle > spread.shortStrike) assert.ok(Math.abs(spread.pnlUsd! - credit) < 1e-9 && credit > 0);
    else assert.ok(Math.abs(spread.pnlUsd! + maxLoss + 2 * 4.81 * 0.00015 * settle) < 0.01, `pnl ${spread.pnlUsd} vs ${-maxLoss}`);
  }
});

function chain(spot: number, now: number): { options: Option[]; spot: number } {
  const options: Option[] = [];
  for (const hours of [6, 22, 46]) {
    const expiryMs = now + hours * 3_600_000;
    for (let strike = 75_000; strike <= 78_000; strike += 500) {
      const mid = putPrice(spot, strike, hours / 8760, 0.45);
      options.push({
        name: `BTC_USDC-T${hours}-${strike}-P`, strike, expiry: new Date(expiryMs).toISOString().slice(0, 10), expiryMs,
        daysToExpiry: hours / 24, type: 'put', bid: mid * 0.95, ask: mid * 1.05, mark: mid, markIv: 45,
        openInterest: 1, volume24h: 1, underlying: spot, index: spot,
      });
    }
  }
  return { options, spot };
}

test('plan: the next expiry at least 12 hours away, selling the first strike below the price and buying the second', () => {
  const now = Date.now();
  const p = planDailySpread(BTC, chain(76_764, now), { enabled: true, minHoursToExpiry: 12 }, now);
  assert.ok('plan' in p, 'skip' in p ? p.skip : '');
  assert.equal(p.plan.shortStrike, 76_500);
  assert.equal(p.plan.longStrike, 76_000);
  assert.equal(p.plan.expiryMs, now + 22 * 3_600_000);
  assert.ok(p.plan.creditUsd > 0 && p.plan.maxLossUsd < 500);
});
