# Credit Spread Strategy: BTC, ETH, SOL

Trades a daily bull put spread (buy a put, sell a higher-strike put) on Deribit's
dollar-settled options, with a live monitoring dashboard. Also holds the earlier
research and backtest. Owner: Ivan. Explain concepts when introducing them.

Part of `~/projects/algorithmic-trading-strategies/`.

## Ivan's rules (latest: 2026-09-13)

1. **Strategy:** every day at the start of the options day, buy the put at the
   **second strike below the price**, then sell the put at the **first strike
   below the price**. This replaced the earlier weekly "farthest strike that meets
   2:1" rule.
2. **Dollar options, measured in dollars.** Ivan asked for USDT; Deribit lists no
   USDT-settled options, so the bot trades its USDC-settled ones (`BTC_USDC-...`).
   Exact USDT would mean another exchange, such as Bybit.
3. **Risk 2% of the current account value per deal.** A deal is the whole spread,
   one construction with one risk; never size or judge the legs separately.
4. **Demo account of $100k**, not the ~$10M test balance. The bot uses
   `capitalUsd: 100000` plus its own P&L as the account value.
5. **Trade by default.** Coins are on unless paused on the dashboard.
6. **Real exchange, not a simulation:** the Deribit test exchange, with trades
   visible in the account.
7. **Limit orders only**, entries and exits. Never pay the spread.
8. **Buy the long put first**, then sell the short. When closing, buy the short
   back first.
9. **Live monitoring:**
   - equity curve, positions, unrealised P&L
   - deals, wins, losses, win rate
   - average % gain per deal, return on risk, risk:reward, profit factor
   - Sharpe, Sortino, drawdown

## Things that produce nonsense if forgotten

**1. `underlying_price` is a per-expiry FORWARD, not spot.** Spot is
`estimated_delivery_price`. An early version used a chain-wide max as spot and
reported intrinsic value as premium, a "1026% return on risk".

**2. Deribit BTC/ETH options without a suffix are INVERSE** (premium in coin).
`BTC-13SEP26-85000-P` marked 0.09976 BTC = $7,710. The bot now trades the LINEAR
`BTC_USDC-...` books instead, where prices are USDC per coin. The backtest data
is inverse.

**3. USDC books are filed under currency `USDC`** (BTC_USDC, ETH_USDC, SOL_USDC
alike).

**4. Standard margin does not net the spread.** The test account is
`segregated_sm`. It locks collateral for the short put as if it stood alone:
~$54k to sell 4.8 BTC_USDC puts whose spread can lose $2k. With 100k USDC, only
one full-size spread fits at a time. The bot never shrinks the size to fit (that
would change the risk); it skips the trade and says why. Portfolio margin would
margin the spread as one position; switching is an account setting for Ivan.

## Deribit USDC options (checked 2026-09-13)

| | tick | min order | contract | near-money strike gap | test-exchange quotes |
|---|---|---|---|---|---|
| BTC_USDC | 5 USDC (20 above 1,000) | 0.01 BTC | 1 BTC | $500 | two-sided |
| ETH_USDC | 0.2 (1 above 50) | 0.1 ETH | 1 ETH | $20-25 | **none on the test exchange** (off by default) |
| SOL_USDC | 0.1 | 10 SOL | 10 SOL | $1 | two-sided |

- Daily expiries at 08:00 UTC. Settlement indexes are `btc_usdc`, `eth_usdc` and
  `sol_usdc`.
- Fees are 0.03% of the underlying per leg (maker = taker), capped at 12.5% of the
  price. Delivery is 0.015%.
- On a daily BTC spread fees are a large share of the credit. For example, $262.50
  and $137.50 mids pay $125 before fees and $85 after.

## The bot (scripts/bot.ts, lib/executor.ts)

`npm run bot` trades on the account in `.env` and serves the dashboard at
http://127.0.0.1:4191 (localhost only).

- **Modes:**
  - `testnet` (default): needs `DERIBIT_TESTNET_CLIENT_ID` and
    `DERIBIT_TESTNET_CLIENT_SECRET` in `.env`, which Ivan pastes himself. Never ask
    for keys in chat.
  - `live`: locked unless Ivan sets `DERIBIT_ALLOW_LIVE=real-money`.
- **Daily entry:** 08:05-10:00 UTC, once per coin per day, on the nearest expiry at
  least `minHoursToExpiry` (12) hours away. If an entry fills nothing, it retries
  after 30 minutes. "Enter now", "Close" and "Stop" act at once.
- **Sizing:**
  - units = floor(riskUsd / max loss per unit at mids, to the minimum order size),
    where riskUsd = 2% of the account value.
  - Entry is skipped if the smallest order already exceeds the budget, or if the
    exchange margin for the short put is more than the free USDC.
- **Execution:**
  - Post-only limit order at the mid for the long put, re-pegged every 20s. The
    long has 20 minutes to fill; nothing held if it doesn't.
  - The short put is offered for exactly the filled amount, never below
    `long cost + fees + (width - riskUsd/amount)`, so the whole spread stays
    within its budget. It has 60 minutes; if it doesn't fill, only the long put is
    held.
  - Closing: buy the short back, then sell the long, with 30 minutes per leg.
  - Positions are held to expiry by default and settled at Deribit's delivery
    price.
  - `maxConcessionPct` (default 0) is how far past the mid an order may reach.
- **Monitoring (`lib/metrics.ts`):**
  - Account value is sampled every 60s to `data/equity-testnet.jsonl`.
  - Per-deal percentages are measured against the account value at entry.
  - Sharpe, Sortino and drawdown are measured on strategy P&L; Sharpe and Sortino
    show only after 7 daily returns.
  - Deribit positions are reconciled against the bot's records every poll.
- **Safety:**
  - Dashboard POSTs need an `X-Bot-Dashboard: 1` header and a local Origin.
  - Order timeouts are resolved by label lookup.
  - A crash mid-placement is recovered through `pendingLabel`.
- **Verified:**
  - 20 tests (`npm test`).
  - 2026-09-13 on the test exchange: authentication, account and positions read,
    and a limit order placed, found by label, moved and cancelled
    (non-filling).

## Earlier research (weekly 2:1 strategy, market-order fills)

Backtest on Deribit's historical tape, 132 Fridays from Mar 2024 to Sep 2026
(`lib/backtest.ts`, `npm run backtest`):
- A 2:1 loss cap forces near-the-money strikes.
- BTC was marginally positive with a knowable market filter (not statistically
  significant); ETH was mixed; SOL lost.
- ~80% wins appeared only with hindsight-perfect regime calls, or at ~4:1 risk.
- Friction was 11-15% of credit on narrow spreads.

The current daily strategy has not been backtested.

## Hard rules for code

1. **Limit orders only, post-only.** Never price past the mid unless Ivan raises
   `maxConcessionPct`.
2. **One spread, one risk.** Size the pair from the account's risk budget. Never
   shrink it for margin; skip instead.
3. **Keep the leg order.** The long is bought before the short is sold, the short
   never exceeds the long filled, and the short is bought back first.
   `test/executor.test.ts` guards this.
4. **Prices come from the exchange.** Models (`lib/blackscholes.ts`) are only for
   odds and small price shifts.
5. Keys live only in `.env`. Account settings (margin model, transfers) are
   changed by Ivan.

## Commands

```
npm run bot        # trade on the Deribit test account + dashboard at http://127.0.0.1:4191
npm test           # execution and metrics tests
npm run backtest   # earlier weekly-strategy backtest (npm run history first)
npm run spreads    # earlier weekly-strategy live finder
```
