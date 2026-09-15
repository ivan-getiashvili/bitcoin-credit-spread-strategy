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
3. **Risk 1% of the current account value per deal** (2% until 2026-09-14, when
   Ivan lowered it to run three coins at once). A deal is the whole spread, one
   construction with one risk; never size or judge the legs separately.
4. **Demo account of $100k**, not the ~$10M test balance. The bot uses
   `capitalUsd: 100000` plus its own P&L as the account value.
5. **Trade by default: BTC, ETH and SOL, one spread each, every day.** Ivan
   turned all three on 2026-09-14 to collect deal data (SOL had been dropped the day
   before; ETH had shown no test-exchange quotes, but trades in the morning window).
   The first deals were started by hand on 2026-09-14 at 16:52 UTC; from
   2026-09-15 the 08:05 UTC schedule takes over.
   - **First deals (2026-09-14 evening):** SOL 100 × 102/101 puts, credit $23.83,
     max loss $76.17 (only 100 of 1,310 filled before the price moved). BTC 2.32 ×
     78,500/78,000, credit $169.88, max loss $990.12; the long filled after 11 min,
     the short after 5. ETH was refused: the test exchange's ETH marks at that hour
     were nonsense (a put marked wider than the spread), so it sized at 0. Both
     spreads expire 2026-09-15 08:00 UTC and are settled by the bot after 08:10.
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
11. **Runs on Cloudflare at https://cryptospread.trade** (moved 2026-09-14, Ivan's
    decision). Order of work Ivan set: Cloudflare and domain first (done), then his
    strategy changes, dashboard design and metrics, then open the first deal
    manually and let the cron schedule the next ones.
    - **Worker:** `cryptospread` (`worker/index.ts`, `wrangler.jsonc`) on Ivan's
      account, also at https://cryptospread.ivan-getiashvili.workers.dev.
    - **Two timers, one cycle a minute** (`lib/bot.ts`). Each timer can start the
      same cycle, whichever fires first:
      - the cron trigger `* * * * *`;
      - the alarm of the `Scheduler` Durable Object, which re-arms itself a minute
        after every run.
      - **Why two:** on 2026-09-14 Cron Triggers did not fire once in 45 minutes,
        on the whole account. Cloudflare's "Workers Cron Triggers degraded" incident of
        2026-09-09 was marked resolved, but Workers still showed degraded.
      - **One at a time:** the D1 `lease` row runs one cycle at a time and keeps them
        at least 40 s apart. Locally, a cron fired just after an alarm cycle was
        skipped.
      - **Self-healing:** a `/api/state` request re-arms the alarm when the data is
        more than 3 minutes old.
      The option chain is read every minute in the entry window or while orders work,
      otherwise every 5 minutes (`idleChainSeconds`).
    - **Memory:** D1 database `cryptospread` (id `0a0fb1b1-c17d-44f0-aa71-c45600e0294a`):
      - `kv`: `state` (the whole bot state), `view` (dashboard data), `lease`.
      - `samples`: the account value once a minute, a permanent record.
      - `commands`: manual actions.
      The dashboard metrics come from a running summary in the state (`EquityAgg`),
      never from reading `samples` back.
    - **Dashboard:** `GET /` and `GET /api/state` only, read-only; anything else is
      404, and POST is 405. The page polls `/api/state` every minute.
    - **Manual actions:** insert a row through the Cloudflare connector's D1 query,
      e.g. `INSERT INTO commands (kind, payload) VALUES ('enter', '{"market":"BTC"}')`.
      Kinds: `enter {market}`, `close {id}`, `stop {jobId}`, `trading {market,on}`. The
      next cycle claims it, runs it and writes `result`. Anything that trades needs
      Ivan's go-ahead first.
    - **Deploys:** Workers Builds from GitHub `main`: trigger "Deploy main", build
      token "cyclebasis build token", `NODE_VERSION=24`. It runs `npm test` then
      `npx wrangler deploy`. Every push to main redeploys, and a failing test blocks the
      deploy.
    - **Keys:** `DERIBIT_TESTNET_CLIENT_ID` and `DERIBIT_TESTNET_CLIENT_SECRET` on the
      Worker, added by Ivan in the Cloudflare dashboard on 2026-09-14 as plain **Text**
      variables (readable in the dashboard; he chose to keep the key that was exposed
      in chat). `keep_vars: true` in wrangler.jsonc stops deploys from wiping them.
      Never set or read the values from here; to check them, compare SHA-256
      fingerprints (that is how a one-character typo in the ID was found). The bot
      logged in at 16:35 UTC: 100,000 USDC, segregated_pm.
    - **Pausing a coin:**
      `INSERT INTO commands (kind, payload) VALUES ('trading', '{"market":"BTC","on":false}')`
      (`"on":true` to resume). BTC was paused for a few hours on 2026-09-14 and
      resumed the same evening.
    - **Domain:** cryptospread.trade plus www, bought 2026-09-14 through Cloudflare
      Registrar. It cost $4.18 and renews at $5.18 a year, with auto-renew off and WHOIS
      privacy on.
    - **Plan:** Workers Free, which allows 10 ms of CPU per cycle. Reading the ~1.4 MB
      USDC chain is the heaviest step; if cycles start failing, check CPU time in Workers
      observability before anything else.
    - **Repo:** public, `ivan-getiashvili/bitcoin-credit-spread-strategy`, default branch
      `main`, homepage cryptospread.trade.
    - **Why not GitHub Actions:** only 5 of ~90 scheduled runs ran on 13-14 Sep, and
      GitHub's Actions terms rule out running a "serverless application". The workflow,
      the GitHub Pages copy and the server/tunnel files were removed on 2026-09-14.
    - **Never run `npm run bot`** (the local runner) against the same account while
      the Worker has keys: both would trade.

## Dashboard (page/index.html), Ivan's wishes 2026-09-14

- He likes the layout; it has everything he needs. Don't redesign it.
- No "testnet / fake money / read-only" badge: the header carries a one-sentence
  strategy description instead. The red LIVE badge appears only in live mode.
- No Activity (event log) panel.
- Title and header: "Crypto Spread", after the domain.

## When the dailies trade (`npm run liquidity`, 2026-09-14)

Real exchange, 30 days, BTC/ETH/SOL USDC options expiring within 2 days, 12,382
trades (BTC 3,071, ETH 3,800, SOL 5,511):
- **Busiest hours (UTC):** 08 (39.5 trades/day, the settlement hour), 13 (35, US
  morning), 09 (27), 14 (25), 21 (23). Quietest: 00-07 (8-13/day).
- **Distance from the mark** (how much takers pay to cross): widest 00-07 UTC
  (13-24%) and 21-23 (18%), 12% at 08, tightest 09-12 and 15-19 (~9%).
- **Weekdays:** Thu 606, Wed 538, Fri 487, Sun 451, Mon 344, Tue 239, Sat 223
  trades/day. Only 4 weeks of data; don't skip days on it.
- **Reading for our orders:** the bot rests at the mid and needs takers to cross
  to it. The 08-10 window has the most takers (33/hour) paying the most, which is
  good for a resting order; 09-11 has tighter spreads, which matters only when the
  15-minute rule makes us cross. Keep 08:05-10:00 for now; the bot records its
  own fill times, so revisit after a few weeks of real fills.
- The test exchange's history only reaches back about two days, and its marks
  are unreliable, so its "distance from mark" column means nothing there.
- **test.deribit.com goes down for minutes at a time** (HTTP 502 on every
  endpoint, 14 Sep 17:38-18:02 UTC, from the Mac as well as from Cloudflare). The
  bot logs "Could not read the Deribit account", keeps its positions and order
  records, retries every minute and logs "readable again". Nothing to do.

## Test-exchange liquidity (checked 2026-09-14)

- Quotes on the test exchange come and go. At 16:43 UTC none of the next-day BTC,
  ETH or SOL USDC puts had a bid and an ask; yesterday afternoon BTC did.
- Daily USDC options do trade there in the 08:00-10:00 UTC entry window: 464 trades
  today, mostly ETH_USDC (252), then BTC_USDC (21) and SOL_USDC (7). So fills in the
  window are possible for all three, but never guaranteed. The plan is priced off
  marks when there is no quote.
- The real exchange quotes all three dailies both sides near the money (BTC 16/28,
  ETH 24/37, SOL 5/24 strikes at 16:45 UTC).

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

## The bot (lib/bot.ts, lib/executor.ts)

The code is split so a strategy change happens in one place:

- **`lib/bot.ts`** is the whole bot as cycles: planning, sizing, margin, entries,
  order work, settlement, reconciliation, the dashboard view and commands. It keeps
  everything a later cycle needs in the state, so every cycle can run in a fresh
  process. The shape of that state is `lib/state.ts`.
- **`worker/index.ts`** is production on Cloudflare: cron, D1, the public page.
- **`scripts/bot.ts`** is the local runner for development (`npm run bot`):
  - state kept in `data/` files (`lib/store.ts`)
  - a new cycle every `pollSeconds`
  - a private dashboard with buttons at http://127.0.0.1:4191
  - a read-only copy at http://127.0.0.1:4192

  Buttons accept requests only from localhost and `controlOrigins`.
- **`npm run worker:dev`** runs the Worker locally with a local D1 and the keys from
  `.env`. `curl localhost:8787/__scheduled` runs one cycle.

- **Modes:**
  - `testnet` (default): needs `DERIBIT_TESTNET_CLIENT_ID` and
    `DERIBIT_TESTNET_CLIENT_SECRET`. On Cloudflare they are Worker secrets; locally
    they live in `.env`. Ivan enters keys himself. Never ask for keys in chat.
  - `live`: locked unless Ivan sets `DERIBIT_ALLOW_LIVE=real-money`.
- **Daily entry:** 08:05-10:00 UTC, once per coin per day, on the nearest expiry at
  least `minHoursToExpiry` (12) hours away. If an entry fills nothing, it retries
  after 30 minutes. "Enter now", "Close" and "Stop" act at once.
- **Sizing:**
  - units = floor(riskUsd × (1 − `sizingSlackPct`/100) / max loss per unit at mids, to
    the minimum order size), where riskUsd = 1% of the account value and the slack
    is 5%. The slack exists because the first BTC entry on 2026-09-14 was cancelled
    at once: sized to the budget exactly at chain mids, a few dollars of movement in
    the live book made the price floor refuse it. The 1% cap is still enforced by
    the floor at order time; the slack only stops false refusals.
  - Entry is skipped if the smallest order already exceeds the budget, or if the
    spread's margin is more than the free USDC. Under portfolio margin, that
    margin comes from `pme/simulate` of the whole spread; under standard margin,
    from the short put's `get_margins` quote.
  - Each coin card shows the margin today's spread needs.
- **Execution:**
  - Post-only limit order at the mid for the long put, re-pegged every 20s (every
    cycle on Cloudflare). The long has `buyLongMinutes` (15) at the mid; nothing is
    held if it doesn't fill.
  - **If prices move against the entry while buying, the plan is cut to what the
    budget allows at the new prices and the buy carries on** (`resizeToBudget`).
    Before 2026-09-14 it stopped instead: the first SOL deal filled 100 of 1,310,
    the put rose from 0.20 to 0.30, and the bot sold shorts against the 100 only, a
    $76 deal on a $1,000 budget. Ivan wants each deal to risk about the full 1%. The
    budget is still a ceiling, never a target: the resized plan is always smaller.
  - The short put is offered for exactly the filled amount, never below
    `long cost + fees + (width - riskUsd/amount)`, so the whole spread stays
    within its budget. It has `sellShortMinutes` (15).
  - **Every leg: 15 minutes at the mid, then 15 at the other side of the book**
    (Ivan's rule, 2026-09-14: "if any leg is not filled after fifteen minutes, buy
    at the market"). The second stage is a limit order at the best ask (buying) or
    bid (selling) with post-only off, so it fills like a market order but cannot
    fill at a silly price in a thin book. It still obeys the risk budget: a buy
    capped by `longMax` or a sell below the floor rests at the limit instead
    (`job.taking`, `takeMinutes`). Taker and maker fees are equal on Deribit
    options, so taking costs only the spread.
  - **Unwind: never hold the long puts alone.** If the short still does not
    fill, the long puts are sold back: at the mid for `unwindMinutes` (15), then at
    the bid for `takeMinutes`. The record ends `unwound` with the small realised
    cost, counted as a finished deal. Only if even the bid finds no buyer are the
    puts kept (`long-only`). Ivan called holding to expiry "another strategy, just
    gambling". A partly filled short opens a spread for the filled part and unwinds
    the rest.
  - Why 15 minutes: a judgment, not a measurement. The order is re-pegged to the
    mid every minute; after 15 minutes without a trade through it, the market has
    usually drifted from where the spread was sized and the floor blocks the sell.
    On 2026-09-14 evening the fills took 4 min (SOL) and 11 min (BTC).
  - **Deribit combo orders** would fill both legs at once, but nobody quotes combos
    on the USDC puts (test or real exchange), so a combo order would sit forever.
  - Closing: buy the short back, then sell the long, `exitLegMinutes` (15) at the
    mid per leg, then `takeMinutes` at the other side.
  - Positions are held to expiry by default and settled at Deribit's delivery
    price.
  - `maxConcessionPct` (default 0) is how far past the mid an order may reach.
- **Monitoring (`lib/metrics.ts`):**
  - Account value is sampled every 60s: to D1 `samples` on Cloudflare, to
    `data/equity-testnet.jsonl` locally. The metrics and chart come from the running
    `EquityAgg` in the state; `test/equity-agg.test.ts` checks it matches the
    whole-history calculation exactly.
  - Per-deal percentages are measured against the account value at entry.
  - Sharpe, Sortino and drawdown are measured on strategy P&L; Sharpe and Sortino
    show only after 7 daily returns.
  - Deribit positions are reconciled against the bot's records every poll.
- **Safety:**
  - The public Worker has no route that trades; manual actions go through D1
    `commands`.
  - Local dashboard POSTs need an `X-Bot-Dashboard: 1` header and a local Origin.
  - Order timeouts are resolved by label lookup.
  - A crash mid-placement is recovered through `pendingLabel`.
- **Verified:**
  - 24 tests (`npm test`).
  - 2026-09-13 on the test exchange: authentication, account and positions read,
    and a limit order placed, found by label, moved and cancelled
    (non-filling).
  - 2026-09-14, local Worker (`wrangler dev`): one cycle took 1.4 s. It read the
    account (portfolio margin) and planned the next BTC spread, 77,000/77,500,
    5.16 BTC, $2,046 margin. The page renders read-only and POST returns 405.
  - 2026-09-14, deployed by Workers Builds: tests passed and cryptospread.trade,
    www and workers.dev serve the dashboard.

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

1. **Limit orders only.** Post-only at the mid first; after `takeMinutes` a leg may
   cross to the other side of the book (Ivan's rule), but never past the risk
   budget's limit. No market orders: a thin book could fill one at any price.
2. **One spread, one risk.** Size the pair from the account's risk budget. Never
   shrink it for margin; skip instead.
3. **Keep the leg order.** The long is bought before the short is sold, the short
   never exceeds the long filled, and the short is bought back first.
   `test/executor.test.ts` guards this.
4. **Prices come from the exchange.** Models (`lib/blackscholes.ts`) are only for
   odds and small price shifts.
5. Keys live only in Worker secrets (Cloudflare) and `.env` (local), both entered by
   Ivan. Account settings (margin model, transfers) change only on Ivan's explicit
   instruction; he asked for portfolio margin on 2026-09-13.
6. **The Worker's CPU budget is small** (10 ms per cycle on Workers Free). Don't
   add per-cycle work that parses large responses. Reuse `getBookSummaries` once per
   currency and single-instrument `getInstrumentSpec`, never the full instrument list.

## Commands

```
git push origin main   # deploys to Cloudflare (Workers Builds runs npm test first)
npm test               # execution, metrics and equity-summary tests
npm run worker:dev     # the Worker locally; curl localhost:8787/__scheduled runs a cycle
npm run worker:bundle  # bundle check without deploying (dist/)
npm run bot            # local runner + dashboards; never alongside the live Worker
npm run backtest       # earlier weekly-strategy backtest (npm run history first)
npm run spreads        # earlier weekly-strategy live finder
```
