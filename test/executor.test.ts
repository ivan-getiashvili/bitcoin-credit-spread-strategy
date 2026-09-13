/**
 * The limit-order execution rules, checked against a fake exchange whose books,
 * resting orders and fills the tests control. These are the promises the bot
 * makes with money: limit orders at the mid only, long put first, never more short
 * than long, never a short sold below the 2:1 price, and nothing left uncovered
 * when a leg does not fill.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { putPrice } from '../lib/blackscholes.ts';
import type { Broker, OrderView, Side } from '../lib/broker.ts';
import { toTick, type Book, type InstrumentSpec, type Option } from '../lib/deribit.ts';
import { advanceJob, openEntry, openExit, planEntry, settleSpread, stopJob, type ExecSettings, type JobContext, type Plan } from '../lib/executor.ts';
import { MARKETS } from '../lib/markets.ts';

const BTC = MARKETS.BTC;
const SHORT = 'BTC-9OCT26-76000-P';
const LONG = 'BTC-9OCT26-72000-P';
const SPEC: InstrumentSpec = { name: 'test', tickSize: 0.0001, tickSteps: [{ above: 0.005, tick: 0.0005 }], minAmount: 0.1, contractSize: 1 };
const settings = { dte: 28, widthPct: 0.05, maxLossToCredit: 2, amount: 0.1 };
const exec: ExecSettings = { repriceSeconds: 30, maxConcessionPct: 0, buyLongMinutes: 30, sellShortMinutes: 120, exitLegMinutes: 60 };
const plan: Plan = {
  market: 'BTC', expiry: '2026-10-09', expiryMs: Date.parse('2026-10-09T08:00:00Z'), spot: 77000,
  shortName: SHORT, shortStrike: 76000, shortIv: 0.45, longName: LONG, longStrike: 72000,
  creditUsd: 1417, maxLossUsd: 2675, lossToCredit: 1.89, distancePct: 1.3, shortDelta: 0.45, marketWinPct: 57,
};

// Mids: short put 0.031 BTC, long put 0.012 BTC. Selling and buying there collects
// 0.0184 BTC per spread after fees ($1,417) against a max loss of $2,675: 1.89:1.
function books(): Record<string, Book> {
  return {
    [SHORT]: { bids: [[0.030, 5]], asks: [[0.032, 5]], mark: 0.031, index: 77000 },
    [LONG]: { bids: [[0.011, 5]], asks: [[0.013, 5]], mark: 0.012, index: 77000 },
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
  let now = Date.parse('2026-09-11T08:10:00Z');
  const ctx: JobContext = {
    broker: ex, market: BTC, settings, exec,
    book: async (n) => structuredClone(ex.books[n]),
    spec: () => SPEC,
    index: () => 77000,
    now: () => now,
    save: () => {},
    log: () => {},
  };
  const { spread, job } = openEntry(BTC, plan, settings, now);
  const step = async (seconds = 0) => {
    now += seconds * 1000;
    await advanceJob(job, spread, ctx);
  };
  return { ex, ctx, spread, job, step };
}

test('tick grid: rounds buys down and sells up, with the coarser tick above 0.005', () => {
  assert.equal(toTick(0.01234, SPEC, 'down'), 0.012);
  assert.equal(toTick(0.01234, SPEC, 'up'), 0.0125);
  assert.equal(toTick(0.00437, SPEC, 'up'), 0.0044);
});

test('buys the long put first, with a limit order at the mid, and offers nothing else', async () => {
  const { ex, step, spread } = setup();
  await step();
  await step(10);
  assert.deepEqual(ex.sent, [`buy 0.1 ${LONG} @ 0.012`]);
  assert.equal(spread.status, 'opening');
});

test('offers the short put only after the long fills, for exactly the amount bought', async () => {
  const { ex, step, spread } = setup();
  await step();
  ex.fill(LONG);
  await step(5);
  assert.deepEqual(ex.sent, [`buy 0.1 ${LONG} @ 0.012`, `sell 0.1 ${SHORT} @ 0.031`]);
  assert.equal(spread.amount, 0);
  ex.fill(SHORT);
  await step(5);
  assert.equal(spread.status, 'open');
  assert.equal(spread.amount, 0.1);
  assert.equal(spread.spareLong, 0);
  assert.ok(Math.abs(spread.creditUsd - 1416.8) < 0.01, `credit ${spread.creditUsd}`);
  assert.ok(spread.lossToCredit <= 2, `loss:credit ${spread.lossToCredit}`);
});

test('follows the mid as the market moves, never reaching for the other side', async () => {
  const { ex, step } = setup();
  await step();
  ex.books[LONG] = { bids: [[0.0115, 5]], asks: [[0.0135, 5]], mark: 0.0125, index: 77000 };
  await step(31);
  assert.equal(ex.sent.at(-1), `move ${LONG} @ 0.0125`);
});

test('never offers the short put below the price that keeps max loss within 2× the credit', async () => {
  const { ex, step } = setup();
  await step();
  ex.fill(LONG);
  ex.books[SHORT] = { bids: [[0.020, 5]], asks: [[0.022, 5]], mark: 0.021, index: 77000 };
  await step(5);
  // Floor: long cost 0.012 + fees 0.0006 + minimum credit 0.0177 = 0.0303, up to the tick: 0.0305.
  assert.equal(ex.sent.at(-1), `sell 0.1 ${SHORT} @ 0.0305`);
});

test('buys nothing when the credit rule cannot be met at mid prices', async () => {
  const b = books();
  b[SHORT] = { bids: [[0.020, 5]], asks: [[0.022, 5]], mark: 0.021, index: 77000 };
  const { ex, step, spread, job } = setup(b);
  await step();
  assert.deepEqual(ex.sent, []);
  assert.equal(spread.status, 'cancelled');
  assert.equal(job.phase, 'done');
});

test('a long put that never fills is cancelled at its time limit, and no short is offered', async () => {
  const { ex, step, spread } = setup();
  await step();
  await step(30 * 60);
  assert.deepEqual(ex.sent, [`buy 0.1 ${LONG} @ 0.012`, `cancel ${LONG}`]);
  assert.equal(spread.status, 'cancelled');
});

test('a partly filled long put at its time limit: short puts are offered for only that many', async () => {
  const { ex, step } = setup();
  await step();
  ex.fill(LONG, 0.05);
  await step(30 * 60);
  assert.deepEqual(ex.sent, [`buy 0.1 ${LONG} @ 0.012`, `cancel ${LONG}`, `sell 0.05 ${SHORT} @ 0.031`]);
});

test('a short put that does not fill in time leaves only the long put', async () => {
  const { ex, step, spread } = setup();
  await step();
  ex.fill(LONG);
  await step(5);
  await step(120 * 60);
  assert.equal(ex.sent.at(-1), `cancel ${SHORT}`);
  assert.equal(spread.status, 'long-only');
  assert.equal(spread.spareLong, 0.1);
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
  assert.deepEqual(s.ex.sent, [`buy 0.1 ${SHORT} @ 0.031`]);
  s.ex.fill(SHORT);
  await advanceJob(exit, s.spread, s.ctx);
  assert.deepEqual(s.ex.sent, [`buy 0.1 ${SHORT} @ 0.031`, `sell 0.1 ${LONG} @ 0.012`]);
  s.ex.fill(LONG);
  await advanceJob(exit, s.spread, s.ctx);
  assert.equal(s.spread.status, 'closed');
  // A round trip at unchanged mids costs only fees: 4 legs × 0.0003 BTC × 0.1 × $77,000 = $9.24.
  assert.ok(Math.abs(s.spread.pnlUsd! + 9.24) < 0.001, `pnl ${s.spread.pnlUsd}`);
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
  await ex.limitOrder('buy', LONG, 0.1, 0.012, job.pendingLabel);
  ex.sent.length = 0;
  await advanceJob(job, spread, ctx);
  assert.deepEqual(ex.sent, []);
  assert.equal(job.order?.label, `${spread.id}-BL1`);
});

test('settlement: a win keeps the credit; a crash can lose more than the stated max loss', async () => {
  for (const settle of [80_000, 60_000]) {
    const { ex, step, spread } = setup();
    await step();
    ex.fill(LONG);
    await step(5);
    ex.fill(SHORT);
    await step(5);
    const maxLoss = spread.openedAmount * spread.maxLossUsd;
    settleSpread(BTC, spread, settle);
    assert.equal(spread.status, 'settled');
    if (settle > 76_000) assert.ok(spread.pnlUsd! > 0 && spread.pnlUsd! < maxLoss);
    else assert.ok(spread.pnlUsd! < -maxLoss, `inverse crash loss ${spread.pnlUsd} vs max ${-maxLoss}`);
  }
});

function chain(spot: number, days: number, iv: number, now: number): { options: Option[]; spot: number } {
  const expiryMs = now + days * 86_400_000;
  const options: Option[] = [];
  for (let strike = 60_000; strike <= 77_000; strike += 1000) {
    const mid = putPrice(spot, strike, days / 365, iv) / spot;
    options.push({
      name: `BTC-TEST-${strike}-P`, strike, expiry: new Date(expiryMs).toISOString().slice(0, 10), expiryMs,
      daysToExpiry: days, type: 'put', bid: mid * 0.97, ask: mid * 1.03, mark: mid, markIv: iv * 100,
      openInterest: 10, volume24h: 1, underlying: spot, index: spot,
    });
  }
  return { options, spot };
}

test('planEntry: a looser loss cap moves the short put further from the money', () => {
  const now = Date.now();
  const c = chain(77_000, 28, 0.5, now);
  const strikeAt = (cap: number) => {
    const p = planEntry(BTC, c, { ...settings, maxLossToCredit: cap }, now);
    assert.ok('plan' in p, `cap ${cap}: ${'skip' in p ? p.skip : ''}`);
    assert.ok(p.plan.lossToCredit <= cap && p.plan.shortStrike < 77_000);
    return p.plan.shortStrike;
  };
  const s2 = strikeAt(2);
  const s4 = strikeAt(4);
  const s10 = strikeAt(10);
  assert.ok(s2 >= s4 && s4 >= s10 && s2 > s10, `strikes ${s2} / ${s4} / ${s10}`);
});

test('planEntry: no trade when no expiry is near the target', () => {
  const now = Date.now();
  const p = planEntry(BTC, chain(77_000, 28, 0.5, now), { ...settings, dte: 7 }, now);
  assert.ok('skip' in p);
});
