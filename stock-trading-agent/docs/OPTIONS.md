# Options support

## Symbols

Contracts use the OCC format `ROOT + YYMMDD + C/P + strike x 1000 (8 digits)`:

```
NVDA261120C00130000  ->  NVDA, 2026-11-20, CALL, strike 130.00
SPY261120P00540000   ->  SPY,  2026-11-20, PUT,  strike 540.00
```

`OptionContract.from_occ()` / `.occ_symbol` convert between the two forms. Every option skill
also accepts `underlying` + `expiration` + `strike` + `right` instead of a symbol.

## Supported strategies

| Strategy | Skills | Max loss | Risk check |
|---|---|---|---|
| Long call / long put | `buy_option`, then `sell_option_to_close` | premium paid | premium and exposure caps, DTE |
| Covered call | own 100 shares, then `sell_covered_call`; exit with `buy_option_to_close` | stock downside, less premium | shares cover all short calls |
| Cash-secured put | `sell_cash_secured_put`; exit with `buy_option_to_close` | strike x 100, less premium | buying power >= collateral |
| Roll | `buy_option_to_close` + new `sell_*` | n/a | each leg checked separately |
| Protective put | own shares + `buy_option` (put) | n/a | premium caps |

Multi-leg spreads (verticals, iron condors) and naked selling are **not** supported. They'd
need multi-leg order support in the broker layer and margin-aware risk rules.
`allow_naked_options=true` turns off the coverage checks, but don't do that unless you know
your margin requirements.

## Pricing and Greeks

`get_option_chain` reports broker bid/ask, plus a delta/theta estimate from Black-Scholes with
the `implied_vol` you pass (default 25%). Treat the Greeks as rough guides. For precise
values, use your broker's implied volatility.

The paper broker prices options with Black-Scholes at 25% vol and a ~4% spread. Option limit
orders fill if they're at or through the mid. Commission is $0.65 per contract.

## Things this project doesn't handle (yet)

- Early assignment and exercise, expiration processing (paper positions don't expire on their own)
- Dividends, corporate actions, adjusted contracts
- Multi-leg orders and margin
