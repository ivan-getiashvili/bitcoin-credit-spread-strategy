# Credit Spread Strategy: BTC, ETH, SOL

Finds, backtests and trades bull put spreads (sell a put, buy a lower-strike put)
on Deribit options for BTC, ETH and SOL, with a live monitoring dashboard.
Owner: Ivan. Explain concepts when introducing them.

Part of `~/projects/algorithmic-trading-strategies/`.

## Ivan's trading rules (latest: 2026-09-13)

1. Bull put spreads only, in range or bull markets. Ivan judges the cycle himself
   and does not sell puts when "everything is red".
2. **Real exchange, not a simulation.** Trades run on a Deribit account and show
   there. For now that is the **Deribit test exchange** (fake money).
3. **Limit orders only, for entries and exits.** No market orders: never pay the
   spread. (This replaced an earlier "market orders only" instruction.)
4. Buy the long (lower) put first, then sell the short put. Never be short an
   uncovered option. When closing, buy the short back first.
5. Risk at most $2 to make $1 (max loss <= 2 x credit), aiming for ~80% wins.
   The backtest shows these two pull against each other; see Findings.
6. **Monitoring must be live:**
   - an equity curve
   - current positions and unrealised P&L
   - the full set of metrics: deals, wins, losses, win rate, risk:reward,
     profit factor, Sharpe, Sortino, drawdown

## Three things that produce nonsense if forgotten

**1. `underlying_price` is a per-expiry FORWARD, not spot.** The June 2027
forward sits ~$3,000 above the front-month one. An early version took a
chain-wide `max()` and called it spot, which priced a two-hour option off a
nine-month forward and reported $2,700 of intrinsic value as premium, a
"1026% return on risk". Spot is `estimated_delivery_price`.

**2. Deribit BTC and ETH options are INVERSE.** Premiums are quoted in the coin.
Verified: `BTC-13SEP26-85000-P` marked 0.09976 BTC with the index at 77,290, and
0.09976 x 77,290 = $7,710, exactly its intrinsic value.

The credit arrives in coin, so its dollar value shrinks in the very crash that
causes the loss, and the loss can exceed the textbook max. Max loss is computed
at the long strike: `(K1 - K2) - credit_coin x K2`. Deeper crashes go past it.
Measured: ETH fell 42% between the 16 Jan and 6 Feb 2026 expiries, and those
spreads lost 1.2-1.25x their computed max loss.

**3. SOL options are LINEAR and filed under currency `USDC`** (`SOL_USDC-...`,
priced in USDC per SOL, one contract = 10 SOL). An earlier note said Deribit
had no SOL options because it only queried currency `SOL`. It lists ~616.

## Venue

Deribit for all three coins, which means one account and one API.
- BTC open interest 415,264 BTC vs Bybit 16,831.
- SOL open interest 1.19M SOL (~$122M) vs Bybit 114k (~$12M). Bybit trades about
  3x more SOL per day.
- Fees: 0.03% of the underlying per leg for makers and takers alike, capped at
  12.5% of the option price. Delivery fee is 0.015% with the same cap, charged on
  in-the-money options at expiry (dailies exempt).
- Post-only limit orders: if the price would match immediately, Deribit moves it
  just inside the spread instead of crossing. `private/edit` moves a resting
  order; labels (max 64 characters) find orders again.
- The test exchange (test.deribit.com) has its own books: 880 of 1,014 BTC options
  were two-sided when checked.

## Backtest method (lib/backtest.ts)

- Tape comes from `history.deribit.com`: every Friday from the 08:00 UTC
  settlement. The window is 3h for BTC and ETH, and 24h for SOL. Block trades,
  combo legs and liquidations are dropped.
- A taker SELL shows the bid and a taker BUY shows the ask. Each print is
  measured against Deribit's mark at the same instant, and the mark is moved to
  entry with a Black-76 difference. Bid <= mid <= ask is enforced.
- **It models market-order fills (crossing the spread).** The limit-order bot
  pays less friction when it fills, but may not fill; that trade-off is not
  backtested.
- Strike rule: sell the put FARTHEST from the money whose credit still meets
  the loss cap.
- Two market filters:
  - `sma50`: price above its 50-day average. Knowable on the day, so this is the
    honest result.
  - `quarter`: calendar quarters that fell less than 10%. Chosen with hindsight,
    so it is the ceiling of what perfect cycle judgment would earn.
- Verified: P&L recomputed independently for 8,824 trades with 0 mismatches, and
  credits matched against raw prints. A refactor into `lib/spread.ts` left the
  output byte-identical.

## Findings (8 Mar 2024 - 11 Sep 2026, 132 Fridays)

- **The 2:1 cap forces the short strike to the money.** The median short strike
  sits 0.5-1% below spot (BTC, ETH) or 1-3% below (SOL), at delta ~0.45. The
  market's own odds of winning at those strikes are 54-58%.
- **With the knowable filter at 2:1:**
  - BTC: 7 of 8 settings profitable, median +0.08R per trade, where 1R = max loss.
    After correcting for overlapping trades this is not statistically different
    from zero (t <= 0.8).
  - ETH: 3 of 9 settings profitable.
  - SOL: 1 of 34 settings across all caps made money.
- **~80% wins appear only** when max loss is ~4x credit, or with hindsight-perfect
  regime calls. With hindsight, BTC 28d/6% wide at a 3x cap won 86% for +0.28R
  (t 3.2). The gap between the two filters is the value of Ivan's judgment.
- **BTC pays most per unit of risk** under both filters.
- **Friction:**
  - Near-the-money bid/ask as a share of price (BTC/ETH/SOL): 4.1/3.4/5.2% at
    7 days, 2.5/2.1/3.6% at 14 days, 1.7/1.5/2.0% at 28 days.
  - Crossing both spreads costs 11-15% of the credit on 2%-wide spreads, and 3-5%
    on 8%-wide spreads.

## The bot (scripts/bot.ts)

`npm run bot` trades on the Deribit account in `.env` and serves a live dashboard
at http://127.0.0.1:4191. It listens on localhost only.

- **Modes:**
  - `testnet` (default): Deribit test exchange. Needs `DERIBIT_TESTNET_CLIENT_ID`
    and `DERIBIT_TESTNET_CLIENT_SECRET` in `.env`. Ivan creates the keys and
    pastes them into `.env`; never ask for them in chat.
  - `live`: locked unless Ivan himself sets `DERIBIT_ALLOW_LIVE=real-money`.
  - There is no paper mode.
- **Ivan's switch per coin:** nothing opens until he switches a coin on. After
  that the bot starts one entry per Friday 08:05-11:00 UTC window when the rule is
  met at mid prices. If an entry fills nothing, it retries after 30 minutes.
  "Enter now", "Close" and "Stop" act immediately after a confirmation dialog.
- **Execution (`lib/executor.ts`, a resumable job saved after every step):**
  - Post-only limit order at the mid for the long put, re-pegged to the mid
    every 30s. `maxConcessionPct` (default 0) is how far toward the far side it
    may go.
  - The long put has 30 minutes to fill. If nothing fills, the entry is cancelled
    and nothing is held.
  - The short put is then offered for exactly the filled amount, never below
    `long cost + fees + minimum credit`. It has 120 minutes; if it does not fill,
    only the long put is held.
  - Closing: buy the short back, then sell the long, with 60 minutes per leg.
  - Cash accounting in the quote currency is exact for inverse and linear books.
- **Monitoring:**
  - Account equity is sampled every 60s to `data/equity-<mode>.jsonl`.
  - The curve can switch between account equity and strategy P&L.
  - Metrics come from `lib/metrics.ts`: deal stats on finished spreads; Sharpe,
    Sortino and drawdown on STRATEGY P&L. Account equity in USD moves with the
    coin collateral, so ratios on it would measure BTC, not the strategy.
  - Sharpe and Sortino show only after 7 daily returns.
  - Deribit positions are reconciled against the bot's records every poll.
  - State lives in `data/bot-state-<mode>.json`.
- **Safety:**
  - Dashboard POSTs require an `X-Bot-Dashboard: 1` header and a local Origin.
  - Order timeouts are resolved by looking the order up by label.
  - A crash mid-placement is recovered through `pendingLabel`.
  - Settled P&L uses Deribit delivery prices.
- **Verified 2026-09-13:**
  - 19 tests pass (`npm test`), covering leg order, mid pricing, the 2:1 floor,
    timeouts, partial fills, stop, closing order, restart recovery, settlement
    and metrics.
  - Keyless testnet run shows prices, refuses to trade (400), and blocks forged
    requests (403).
  - Dashboard checked with a fixture in light and dark mode.
  - **Real test-exchange orders are not yet verified.** That waits for Ivan's
    keys; the first run should be watched on test.deribit.com.

## Hard rules for code

1. **Limit orders only, post-only.** Never send a market order, and never price
   past the mid unless Ivan raises `maxConcessionPct`.
2. **Keep the leg order.** The long is bought before the short is sold, the short
   is never sold beyond the long filled, and the short is bought back before the
   long is sold. `test/executor.test.ts` guards this.
3. **Never sell an in-the-money option** in a credit spread; reject strikes with
   no open interest (live) or no prints (backtest).
4. **Prices come from the exchange.** `lib/blackscholes.ts` provides delta,
   probabilities, and `putPrice`, which may only shift a real price across small
   time and spot moves. Strategy maths lives once, in `lib/spread.ts`.
5. **Size comes only from `bot.config.json`, set by Ivan.** Code never sizes up
   on its own.

## Commands

```
npm run chain                          # cache today's BTC, ETH, SOL chains
npm run spreads [-- --cap 3]           # today's spreads under the loss cap (market-order view)
npm run history [-- --from 2024-03-08] # cache the Friday tape + delivery prices (a few minutes)
npm run backtest [-- --markets BTC]    # full grid -> data/backtest-results.json
npm run bot                            # trade on the Deribit test account + dashboard at http://127.0.0.1:4191
npm test                               # execution and metrics tests
```
