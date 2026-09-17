/**
 * The text version of the dashboard (lib/summary.ts): what an AI assistant, a crawler or a
 * link preview reads, because they do not run the page's JavaScript.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { headTags, summarize, toHtml, toMarkdown, type StrategyFacts } from '../lib/summary.ts';

const FACTS: StrategyFacts = {
  entry: { fromUtc: '08:05', toUtc: '10:00', weekdays: [5] },
  strategy: { expiry: 'weekly', distanceAtr: 0.5, atrDays: 14, longSteps: 2 },
  markets: [{ id: 'BTC', enabled: true, structure: 'call' }, { id: 'ETH', enabled: true, structure: 'put' }, { id: 'SOL', enabled: false, structure: 'put' }],
  riskPct: 1,
  capitalUsd: 100000,
  mode: 'testnet',
  execution: { buyLongMinutes: 15, takeMinutes: 15 },
  maxOpenSpreads: 4,
};

const T = Date.UTC(2026, 8, 17, 13, 3);
const VIEW = {
  mode: 'testnet', canTrade: true, problems: [], accountError: '', positionWarning: '',
  entry: { ...FACTS.entry, inWindow: false, next: { from: '2026-09-18T08:05:00.000Z', to: '2026-09-18T10:00:00.000Z' } },
  strategy: FACTS.strategy, maxOpenSpreads: 4, execution: FACTS.execution,
  account: { valueUsd: 98907.4992, capitalUsd: 100000, riskPerTradePct: 1, riskUsd: 989.075, exchange: { equity: 98961.73, availableFunds: 96965.1, marginModel: 'segregated_pm' } },
  totals: { unrealizedUsd: 30.3575, openRiskUsd: 1897.4877, open: 1 },
  metrics: {
    deals: { deals: 2, wins: 1, losses: 1, winRatePct: 50, netPnlUsd: -800, profitFactor: 0.23, avgGainPct: -0.4, avgWinPct: 0.24, avgLossPct: -1.04, avgWinUsd: 243.74, avgLossUsd: 1043.68, avgR: -0.4, realizedRiskToReward: 4.28, expectancyUsd: -400, bestDealPct: 0.24, worstDealPct: -1.04, maxConsecutiveLosses: 1, plannedRiskToReward: 4.9 },
    equity: { days: 9, dailyReturns: 8, sharpe: 0.1364, sortino: 0.1755, maxDrawdownUsd: 1229.31, maxDrawdownPct: 1.2293, strategyReturnPct: 0.0853, since: Date.UTC(2026, 8, 4) },
  },
  series: [
    { t: Date.UTC(2026, 8, 4, 23, 59), strategyUsd: 243.74, equityUsd: 100243.74 },
    { t: Date.UTC(2026, 8, 15, 9), strategyUsd: -700, equityUsd: 99300 },
    { t: Date.UTC(2026, 8, 15, 23, 59), strategyUsd: -800, equityUsd: 99200 },
    { t: T, strategyUsd: -1092.5, equityUsd: 98907.5 },
  ],
  seeded: { days: 71, from: '2026-07-03', to: '2026-09-11', deals: 1, markets: ['BTC', 'ETH'], realClosesNeeded: 8, realCloses: 4 },
  positions: [{ instrument: 'ETH_USDC-25SEP26-2400-P', size: -12.7, averagePrice: 54, markPrice: 39.96, floatingPnlUsd: 178.26, delta: 4.342 }],
  markets: [
    { id: 'BTC', tradingOn: true, settings: { enabled: true, structure: 'call' }, spot: 76764.85, sma50: 71945.8, atrPct: 2.85, size: { amount: 0.61, riskUsd: 989.14, minAmount: 0.01, marginUsd: 943.56, freeMarginUsd: 96965.19, marginModel: 'segregated_pm' }, plan: { type: 'call', expiryMs: Date.UTC(2026, 8, 25, 8), hoursToExpiry: 186.9, shortStrike: 78000, longStrike: 80000, creditUsd: 461.44, maxLossUsd: 1538.56, lossToCredit: 3.33, distancePct: 1.61, marketWinPct: 69.08 } },
    { id: 'ETH', tradingOn: true, settings: { enabled: true, structure: 'put' }, spot: 2459.86, sma50: 2218.4, skip: 'No strike far enough from the price is listed yet.' },
    { id: 'SOL', tradingOn: false, settings: { enabled: false, structure: 'put' } },
  ],
  jobs: [],
  spreads: [
    { id: 'ETH-1', market: 'ETH', type: 'put', expiryMs: Date.UTC(2026, 8, 25, 8), openedAt: '2026-09-15T07:54:48.807Z', shortStrike: 2400, longStrike: 2300, amount: 12.7, openedAmount: 12.7, riskUsd: 989.34, creditUsd: 25.11755, maxLossUsd: 74.88245, status: 'open', note: 'A note with <b>markup</b> & a | pipe', live: { distancePct: 2.49, daysLeft: 7.79, unrealizedUsd: 14.07, unrealizedR: 0.0148, chanceAboveShortPct: 62.7, state: 'safe' } },
    { id: 'BTC-1', market: 'BTC', expiryMs: Date.UTC(2026, 8, 15, 8), openedAt: '2026-09-14T16:57:00.000Z', closedAt: '2026-09-15T08:00:00.000Z', settlePrice: 77025, shortStrike: 78500, longStrike: 78000, openedAmount: 2.32, accountUsdAtEntry: 100000, creditUsd: 73.22, maxLossUsd: 426.78, pnlUsd: -1043.68, status: 'settled' },
    { id: 'sim-ETH', market: 'ETH', type: 'put', simulated: true, expiryMs: Date.UTC(2026, 8, 11, 8), openedAt: '2026-09-04T08:05:00.000Z', closedAt: '2026-09-11T08:00:00.000Z', settlePrice: 2467, shortStrike: 2450, longStrike: 2350, openedAmount: 11.9, accountUsdAtEntry: 100000, creditUsd: 20.48, maxLossUsd: 79.52, pnlUsd: 243.74, status: 'settled' },
  ],
  events: [], readOnly: true, snapshotAt: T,
};

test('the text version carries every figure the dashboard shows', () => {
  const s = summarize(VIEW, FACTS);
  const md = toMarkdown(s);
  for (const needle of [
    '# Crypto Spread',
    'Every Friday at 08:05 UTC the bot sells a call spread on BTC and a put spread on ETH at Deribit',
    'Snapshot taken 17 Sep 2026 13:03 UTC',
    'Next entry window: 18 Sep 2026 08:05 UTC',
    'Account value (demo): $98,907.50 ($100,000 starting capital, -$1,092.50)',
    'Risk per spread: 1.0% of the account = $989.08',
    'Unrealised P&L: +$30.36 (1 open spread, $1,897.49 at risk)',
    '| Win rate | 50.0% | 1 of 2 deals |',
    '| Sharpe ratio | 0.14 |',
    '| Max drawdown | -$1,229.31 | 1.23% from the peak |',
    '| ETH | put spread | safe | 25 Sep 2026 08:00 UTC (7.8 days left) | 2,400 / 2,300 | 12.7 ETH | $318.99 | $951.01 |',
    '| ETH_USDC-25SEP26-2400-P | -12.7 | 54.00 | 39.96 | +$178.26 | 4.342 |',
    'buy the 80,000 call, then sell the 78,000 call',
    'ETH: price $2,460. Trading on: opens one put spread every Friday between 08:05 and 10:00 UTC. Price is above its 50-day average of $2,218. No strike far enough from the price is listed yet.',
    'SOL: not traded (switched off).',
    '-$1,043.68 | -1.044% |',
    'win (simulated)',
    '| 2026-09-04 | $100,243.74 | +$243.74 | simulated |',
    '| 2026-09-15 | $99,200.00 | -$800.00 | real |',
    '| 2026-09-17 | $98,907.50 | -$1,092.50 | real |',
    'No orders working.',
    'never holds an uncovered short option',
    'https://cryptospread.trade/api/state',
    'https://github.com/ivan-getiashvili/bitcoin-credit-spread-strategy',
  ]) assert.ok(md.includes(needle), `missing in the Markdown: ${needle}`);
  assert.ok(!/undefined|NaN|\[object/.test(md), 'a missing value leaked into the text');
  // One row per UTC day: the 09:00 sample of 15 Sep gives way to the day's last one.
  assert.ok(!md.includes('$99,300.00'));
  // Notes sit in a list, where Markdown needs no escaping; table rows never gain a column from a stray pipe.
  assert.ok(md.includes('- ETH: A note with <b>markup</b> & a | pipe'));
  for (const row of md.split('\n').filter((l) => l.startsWith('| ETH | put spread | safe'))) assert.equal(row.split(' | ').length, 12);
});

test('the HTML version escapes what it prints and matches the Markdown', () => {
  const s = summarize(VIEW, FACTS);
  const html = toHtml(s);
  assert.ok(html.includes('A note with &lt;b&gt;markup&lt;/b&gt; &amp; a | pipe'));
  assert.ok(!html.includes('<b>markup'));
  assert.ok(html.includes('<td>$318.99</td>'));
  assert.ok(html.includes('<a href="https://cryptospread.trade/llms.txt">'));
  assert.ok(!/undefined|NaN|\[object/.test(html));
});

test('before the first cycle the text version still explains the strategy', () => {
  const s = summarize(null, FACTS);
  const md = toMarkdown(s);
  assert.equal(s.updated, null);
  assert.ok(md.includes('a call spread on BTC and a put spread on ETH'));
  assert.ok(md.includes('has not completed its first cycle'));
  assert.ok(md.includes('## How the bot trades'));
  assert.ok(!/undefined|NaN/.test(md));
});

test('head tags: description, canonical, text alternatives, and schema.org data that parses', () => {
  const s = summarize(VIEW, FACTS);
  const head = headTags(s);
  assert.ok(head.includes('<meta name="description" content="Live dashboard of an automated trading bot that sells weekly credit spreads on BTC and ETH options at Deribit'));
  assert.ok(head.includes('<link rel="canonical" href="https://cryptospread.trade/">'));
  assert.ok(head.includes('type="text/markdown" href="https://cryptospread.trade/llms.txt"'));
  const ld = JSON.parse(head.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
  assert.equal(ld.name, 'Crypto Spread');
  assert.equal(ld.dateModified, new Date(T).toISOString());
});

test('the page keeps the markers the Worker fills, and shows no placeholder as if it were data', () => {
  const page = readFileSync('page/index.html', 'utf8');
  assert.match(page, /<!--HEAD:[^>]*-->/);
  assert.match(page, /<!--STATIC:[^>]*-->/);
  assert.ok(page.includes(".js #static { display: none; }"));
  const markup = page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  assert.ok(!markup.includes('connecting'), 'placeholders belong in the script, not the markup');
  assert.ok(!/>–</.test(markup), 'a dash in the markup reads as a value to a machine');
});
