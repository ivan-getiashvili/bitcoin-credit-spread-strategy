# Bitcoin Credit Spread Strategy

Finds and grades defined-risk vertical credit spreads on Bitcoin options.
Owner: Ivan. Explain concepts when introducing them.

Part of `~/projects/algorithmic-trading-strategies/`.

## Two things that will produce nonsense if you forget them

**1. `underlying_price` is a per-expiry FORWARD, not spot.** The June 2027
forward sits ~$3,000 above the front-month one. An early version took a
chain-wide `max()` and called it spot, which priced a two-hour option off a
nine-month forward, turned deep in-the-money puts into apparently
out-of-the-money ones, and reported $2,700 of intrinsic value as premium — a
"1026% return on risk". Always use each expiry's own forward.

**2. Deribit BTC options are INVERSE.** Premiums are quoted in BTC. Verified:
`BTC-13SEP26-85000-P` marked 0.09976 BTC with the index at 77,290 →
0.09976 × 77,290 = $7,710, exactly its intrinsic value. Treating those as
dollars is off by five orders of magnitude.

The inverse settlement also changes max loss. For a bull put spread:

```
loss_BTC = (K1 - K2)/S - credit
loss_USD = (K1 - K2) - credit x S
```

The width is fixed in dollars but the credit was collected in BTC, so its dollar
value shrinks in the very crash that causes max loss. As S falls the dollar loss
approaches the FULL WIDTH, not width-minus-credit. Both figures are reported;
`maxLossUsdInverse` is the honest one.

## Venue

**Deribit** for BTC and ETH — open interest 415,264 BTC ($33B) versus Bybit's
16,831, roughly 25x. **Deribit lists no SOL options**; Bybit, OKX and Binance do.
So a SOL strategy needs a second venue, and Bybit is the liquid one for it.

## What 0DTE actually pays (measured, not assumed)

At a safe delta the premium is negligible and the spread is enormous:

| expiry | delta | credit | bid/ask cost |
|---|---|---|---|
| 0DTE | 0.08 | **$8** | **67%** |
| 5 days | 0.24 | $464 | 8% |
| 19 days | 0.19 | $697 | 5% |

Theta does decay fastest at 0DTE, but at deltas worth selling there is almost
nothing to collect, and round-trip friction exceeds the credit. Collecting real
premium on 0DTE means selling near the money, where gamma turns it into a coin
flip with an asymmetric payoff. The spread builder returns zero tradable 0DTE
candidates under any sane liquidity filter — that is a finding, not a bug.

## Hard rules

1. **Price at the side of the book you would cross** — sell the short leg at its
   BID, buy the long leg at its ASK. Marks and mid prices manufacture spreads
   that cannot be filled.
2. **Never sell an in-the-money option** in a "credit" spread; the credit is
   intrinsic value, not premium.
3. **Reject strikes with no open interest.** A quote nobody has ever traded is
   not a price.
4. **Prices come from the exchange, models only from `lib/blackscholes.ts`.**
   A model price is an opinion; the bid is a fact.
5. This tool finds candidates. It does not size positions or decide anything.

## Commands

```
npm run chain     # fetch and cache the option chain
npm run spreads   # rank tradable credit spreads
```
