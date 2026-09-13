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
5. **Trade by default.** Coins are on unless paused on the dashboard. SOL was
   dropped at Ivan's request on 2026-09-13 (paused, `enabled: false`); ETH stays off
   because the test exchange quotes no ETH_USDC options. BTC is the only coin trading.
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
10. **No disclaimers, no more what-ifs (2026-09-13).** Don't add "research project /
    backtest negative" notes to public pages, and don't test ideas such as excluding
    bear markets unless he asks. Build it and see where it goes.
11. **Not on the Mac.** The bot runs on GitHub Actions (`.github/workflows/bot.yml`,
    chosen 2026-09-13 over a paid server).
    - **Repo:** PUBLIC since 2026-09-13 (Ivan's choice; the full history was scanned
      clean of keys first), `ivan-getiashvili/bitcoin-credit-spread-strategy`, default
      branch `main`.
    - **Schedule:** each run is `scripts/bot.ts --once`, one cycle of about 20s.
      Runs every 5 min 08:00-10:59 UTC and every 15 min otherwise; Actions minutes
      are unlimited on public repos. GitHub can start scheduled runs late. The
      concurrency group stops two cycles from overlapping.
    - **Dashboard:** GitHub Pages at
      https://ivan-getiashvili.github.io/bitcoin-credit-spread-strategy/. Each run
      builds `_site/` with `npm run site` and deploys it. In `__SNAPSHOT_URL__` mode
      the page reads `public-state.json` every minute and shows how old it is. No
      custom domain yet: putspread.com is taken; putspread.net, .io and .app were free.
    - **State:** lives on the `bot-state` branch (`bot-state-testnet.json`,
      `equity-testnet.jsonl`, and `public-state.json` for the dashboard). That branch
      is the source of truth; local `data/` on the Mac is stale.
    - **Keys:** the `DERIBIT_TESTNET_CLIENT_ID` / `_SECRET` Actions secrets, added
      by Ivan himself with `gh secret set`.
    - **Mac copy:** stopped on 2026-09-13. Never run `npm run bot` while the
      workflow is active: two bots on one account double the trades.
    - **Run one cycle now:** `gh workflow run bot.yml`.

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

**4. Margin model: the test account is on segregated portfolio margin (`segregated_pm`).**
Ivan asked for it on 2026-09-13 so the exchange treats the spread as one position.
- Standard margin (`segregated_sm`, the old setting) locked ~$50-56k for the short
  put alone on a spread that can lose $2k.
- Portfolio margin prices the same 4.84 BTC spread at ~$1,984, about its risk.
- "Segregated" keeps the bot on its own 100,000 USDC. `cross_pm` would pool ~$17M
  of test coins as collateral.
- **`private/get_margins` still quotes an order on its own** ($12,294 for that
  short put under PM). Under PM the bot checks margin with `private/pme/simulate`
  (account positions + unfilled parts of opening entries + the new spread) instead.
- The bot never shrinks a size to fit margin; it skips and says why.

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

`npm run bot` trades on the account in `.env` and serves two dashboards, both on
localhost only:
- **Private** at http://127.0.0.1:4191 (`port`), with the trade buttons.
- **Public, read-only** at http://127.0.0.1:4192 (`publicPort`). It has GET routes
  only and the page is marked `readOnly`, so it shows no buttons.

Going online is planned through Cloudflare Tunnel, with Cloudflare Access in front
of the private dashboard; see `deploy/README.md`. Buttons accept requests only from
localhost and `controlOrigins`. Ivan chose a cloud server and a login-protected
control page. His preferred domain, putspread.com, is taken (parked on Sedo since
2010); putspread.net, .io and .app were free on 2026-09-13.

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
    spread's margin is more than the free USDC. Under portfolio margin, that
    margin comes from `pme/simulate` of the whole spread; under standard margin,
    from the short put's `get_margins` quote.
  - Each coin card shows the margin today's spread needs.
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

## Daily strategy grid search (2026-09-13, `npm run grid`)

Data: every morning from 8 Mar 2024 to 13 Sep 2026 (920 per coin), taken from the
coin-settled BTC/ETH dailies and converted to dollars. BTC_USDC barely traded before
late 2025. `npm run history:daily` caches it; the logic is in `lib/daily-backtest.ts`.

- **Grid:** sold strike 1st-4th below the price × width 1-4 strikes × 1- or 2-day
  expiry × trade every day or only above the 50-day average. That is 64 settings
  per coin.
- **Fills:** each setting is priced at the mid and at bid/ask.
- **Sizing:** 2% risk per spread; delivery fee only on Friday expiries.
- **Selection:** best in-sample Sharpe (Mar 2024 - Dec 2025), then judged on 2026.
- **Verified:** three trades recomputed by hand match exactly.

Results:
- **The current setting (sell #1, width 1, 1-day, every day) loses:**
  - BTC: -0.19%/deal in-sample, -0.26%/deal in 2026, profit factor 0.58, 2026
    drawdown 52%.
  - ETH: -0.17%/deal in 2026, drawdown 42%.
- **No setting has a robust edge.**
  - BTC: 4/64 profitable in-sample at mid (1 at bid/ask); the best were near
    breakeven.
  - ETH: 3/64 in-sample, and all 3 lost in 2026; 0 profitable at bid/ask.
- **Why:** fees are 25% of the gross credit (median $45 of $185 per BTC). Without
  fees the current BTC setting is about breakeven (PF 1.04). A max loss of ~3× the
  credit needs ~75% wins to break even; the setting wins 65%.

## Fees and the wider-wing test (2026-09-13, `npm run wing-test [-- --combo-fees]`)

- **Fees, verified via `get_instruments`:** options are maker 0.0003 = taker 0.0003
  = block 0.0003 of the underlying per leg (~$23 per BTC at $77k), capped at 12.5% of
  the option price.
  - Limit orders do not lower fees; they only avoid paying the bid/ask spread.
- **Combo discount (Deribit support pages):** on a combo with buy and sell legs, the
  fees of the cheaper direction are waived, so a 2-leg spread pays one leg's fee.
  - Confirmed for takers. The wording for makers ("rebates are reduced to zero") is
    unclear; test on the test exchange before relying on it.
  - Combos fill both legs together, which replaces the buy-first rule's purpose.
  - **Tested on the test exchange, 2026-09-13:**
    - `private/create_combo` created `BTC_USDC-PS-18SEP26-77000_70000`. Leg amounts
      are integer ratios (1), not the trade size, and the combo name is in `id`.
    - A 0.01 BTC IOC combo sell priced 20 USDC through the legs' own quotes did not
      fill. The test exchange does not match combos against leg books, and its
      combo books are empty, so the fee waiver cannot be observed there and the bot
      cannot trade combos there. Nothing traded and no position was left.
  - **Real exchange, same day:** there are no BTC_USDC put-spread combo books. The
    coin-settled `BTC-PS-...` books are quoted two-sided at 15-60 BTC. The discount
    is usable in practice only on the coin-settled books, which conflicts with
    Ivan's dollar-options rule.
- **Wing test** (Ivan's idea: sell the first put below the price, buy 0.65%-10%
  below, risk 2% or 5%, 1-day BTC):
  - A wider wing cuts fees from 25% to ~5% of the credit, but max loss : credit
    rises from 3 to 15. The wins needed to break even rise from 75% to 94%, while
    wins achieved only rise from 65% to 73.5%.
  - Every width lost money, at mid and at bid/ask, over the whole period and in 2026.
  - With combo fees the losses halve but remain (profit factor 0.84 at the current
    width, 0.99 at 10%).
  - Wide wings approach zero only because the position gets tiny, not because an
    edge appears.
  - Beyond ~5% width, most long-leg prices are modelled with flat volatility, which
    flatters wide spreads.
- **5% risk per spread** does not change the edge; it multiplies results by 2.5.
  The current setting would have lost 99% of the account (93% with combo fees).

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
5. Keys live only in `.env`. Account settings (margin model, transfers) change
   only on Ivan's explicit instruction; he asked for portfolio margin on 2026-09-13.

## Commands

```
npm run bot        # trade on the Deribit test account + dashboard at http://127.0.0.1:4191
npm test           # execution and metrics tests
npm run backtest   # earlier weekly-strategy backtest (npm run history first)
npm run spreads    # earlier weekly-strategy live finder
```
