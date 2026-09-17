# Crypto Spread

An automated options-trading bot that sells weekly credit spreads on Bitcoin and Ethereum
options at [Deribit](https://www.deribit.com), with a public, read-only, live dashboard:

**https://cryptospread.trade**

The bot runs by itself on Cloudflare, once a minute. Every Friday it opens two positions with
limit orders, holds them to the next Friday's settlement, and publishes everything it does:
account value, open positions, every finished deal, and the performance metrics (win rate,
profit factor, return on risk, Sharpe, Sortino, drawdown).

## For AI assistants, crawlers and scripts

The dashboard draws itself in the browser, so the same content is also served as plain text.
No key, login or JavaScript is needed for any of these.

| What | Where |
| --- | --- |
| The dashboard as Markdown, always current | https://cryptospread.trade/llms.txt |
| The same, by content negotiation | `GET https://cryptospread.trade/` with `Accept: text/markdown` |
| The dashboard page, with the full text version inside the HTML | https://cryptospread.trade/ |
| All data as JSON (account, metrics, equity series, positions, deals, plans) | https://cryptospread.trade/api/state |
| Crawling rules: everyone is allowed | https://cryptospread.trade/robots.txt |

## The strategy

A **credit spread** is two options of the same type and expiry: one sold closer to the price
and one bought further out as protection. The difference in premium is collected up front (the
credit). If the price stays on the safe side of the sold strike until expiry, the credit is the
profit. The most the position can lose is the distance between the strikes minus the credit,
so the risk is known and capped from the start.

- **When:** every Friday at 08:05 UTC, for the options that expire the next Friday.
- **What:** a **call spread on BTC** (profits if Bitcoin does not rally past the sold strike) and
  a **put spread on ETH** (profits if Ethereum does not fall past the sold strike).
- **Strikes:** the sold strike is the first listed strike at least 0.5 × ATR away from the price,
  where ATR is the average absolute daily settlement move over the last 14 days, scaled to the
  week. The bought strike is two listed strikes further out.
- **Size:** each spread is sized so that its maximum loss is 1% of the current account value.
- **Exit:** held to expiry and settled at Deribit's delivery price.
- **Instruments:** Deribit's dollar-settled (USDC) linear options, such as
  `BTC_USDC-25SEP26-78000-C`. Prices, profit and loss are in US dollars.
- **Account:** a $100,000 demo account on the Deribit test exchange. Real-money mode exists in
  the code and is locked behind an explicit environment variable.

The settings live in [bot.config.json](bot.config.json).

## How orders are executed

The execution rules matter as much as the strategy, because an option spread filled carelessly
gives away its whole edge, and a half-filled one is a different, riskier position.

1. **Limit orders only.** Each leg rests at the mid price for 15 minutes and is re-pegged every
   cycle. After that it may cross to the other side of the order book for 15 minutes, as a
   limit order, never past the price the risk budget allows. There are no market orders.
2. **The protective leg first.** The bought option is bought before the short one is sold, and
   the short is offered for exactly the amount that filled. The account never holds an uncovered
   short option. When closing, the short is bought back first.
3. **Never half a spread.** If the short leg does not fill, the bought leg is sold back and the
   deal is recorded as unwound, with its small realised cost.
4. **One spread, one risk.** The pair is sized from the risk budget. If prices move while the
   order works, the plan is cut to what the budget still allows. It is never shrunk to fit
   margin; it is skipped instead.
5. **Margin is checked for the whole spread** with Deribit's portfolio-margin simulation before
   any order is placed.

These rules are guarded by tests in [test/executor.test.ts](test/executor.test.ts).

## How it runs

```
Cloudflare Worker (worker/index.ts)
├── two timers start one bot cycle a minute: a cron trigger and a Durable Object alarm
├── a lease in the D1 database lets only one cycle run at a time
├── the cycle (lib/bot.ts): read the account and the option chain, plan, size, check margin,
│   work the orders, settle expiries, reconcile positions, record the account value
├── state, dashboard data and the minute-by-minute account value live in Cloudflare D1
└── the public site: GET /, /api/state, /llms.txt, /robots.txt, /sitemap.xml, all read-only
```

- Nothing reachable from the internet can place or change an order. Manual actions are rows
  added to a D1 table by the account owner.
- Every push to `main` runs the tests and deploys through Cloudflare Workers Builds. A failing
  test blocks the deploy.
- A whole cycle fits in the 10 ms of CPU that the free Workers plan allows.
- API keys live only in the Worker's settings and in a local `.env` file that is never committed.

## The research behind the strategy

The strategy was chosen from backtests on Deribit's historical trade tape, 921 mornings per
coin from March 2024 to September 2026, with exchange fees on every leg and fills at bid/ask.
Settings were ranked on data up to the end of 2025 and judged on 2026, which they had not seen.

| Study | Command | Finding |
| --- | --- | --- |
| Daily put spreads, 64 settings per coin | `npm run grid` | The fixed fee per leg is 20-30% of one day's premium, so no setting keeps an edge. |
| Strikes chosen by ATR distance, 84 settings per coin | `npm run atr` | Further strikes win more often, but the loss-to-credit ratio rises faster. The one-day expiry is the problem, not the strike. |
| Put spreads, call spreads, iron condors, and the same spreads bought instead of sold, on daily, weekly and monthly expiries | `npm run structures` | On the weekly expiry fees fall to 3-12% of the credit and an edge appears: ETH put spreads and BTC call spreads. The rule in production is the one that was profitable both in-sample and in 2026 for both coins. |
| When the options trade, by hour and weekday | `npm run liquidity` | 08:00-10:00 UTC has the most takers, which suits an order resting at the mid. |

Until the live record is long enough for every metric, the dashboard shows a simulated history
in front of the real one: the same strategy run on real option prices for the previous ten
weeks. Every simulated day and deal is labelled, and the simulation drops out by itself.

## Project layout

| Path | What it is |
| --- | --- |
| [lib/bot.ts](lib/bot.ts) | The whole bot as repeatable cycles, independent of where it runs |
| [lib/executor.ts](lib/executor.ts) | Planning a spread, sizing it, and working its legs as limit orders |
| [lib/broker.ts](lib/broker.ts), [lib/deribit.ts](lib/deribit.ts) | The Deribit API |
| [lib/metrics.ts](lib/metrics.ts) | Deal statistics, the equity curve, Sharpe, Sortino, drawdown |
| [lib/monitor.ts](lib/monitor.ts) | Live state of each open spread |
| [lib/summary.ts](lib/summary.ts) | The dashboard as text and Markdown, for readers without JavaScript |
| [lib/seed.ts](lib/seed.ts), [lib/weekly-backtest.ts](lib/weekly-backtest.ts) | The simulated history |
| [worker/index.ts](worker/index.ts) | Production on Cloudflare: timers, database, the public site |
| [page/index.html](page/index.html) | The dashboard, one file, no framework |
| [scripts/](scripts) | The local runner, data downloads and the research studies |
| [test/](test) | 41 tests: execution rules, settlement, metrics, the text version |
| [CLAUDE.md](CLAUDE.md) | The full project notes: every rule, decision and finding, with dates |

## Run it

Node 22.6 or newer. TypeScript runs directly, with no build step.

```bash
npm install
npm test               # execution, settlement, metrics and text-version tests
npm run worker:dev     # the Worker locally, with a local database
npm run history:tapes  # download the historical option trades (large)
npm run structures     # the structure study
```

To trade on the Deribit test exchange, create an API key at https://test.deribit.com and copy
[.env.example](.env.example) to `.env`. Run only one bot per account.

## Built with

TypeScript, Node.js, Cloudflare Workers, Durable Objects, D1 and Workers Builds, the Deribit
JSON-RPC API, and plain HTML, CSS and SVG for the dashboard. No runtime dependencies.
