# Skills reference

Run any skill with `python -m trading_agent run <skill> key=value ...`. Values are parsed as
JSON when possible (`qty=10`, `symbols='["SPY","QQQ"]'`, `targets='{"VTI":0.6}'`), and as
strings otherwise. Use `python -m trading_agent describe <skill>` to see the exact schema.

All order skills accept:

| Param | Meaning |
|---|---|
| `order_type` | `market` or `limit` (options default to `limit`) |
| `limit_price` | required for stock/ETF limit orders; for options it defaults to the mid |
| `reason` | free text, written to the journal |
| `dry_run` | `true` = run risk checks and return a preview only |

## Market data (read-only)

| Skill | Params | Returns |
|---|---|---|
| `get_quote` | `symbols` (list; tickers or OCC option symbols) | bid / ask / last / mid |
| `get_price_history` | `symbol`, `days` (default 120) | SMA20/50, RSI14, 20-day volatility, 20/60-day momentum, trend |
| `get_option_chain` | `underlying`, `expiration?`, `right?`, `min_delta?`, `max_delta?`, `implied_vol?` | contracts with bid/ask/mid, estimated delta and theta |

## Portfolio

| Skill | Params |
|---|---|
| `get_account` | none |
| `get_positions` | none (includes weight of equity) |
| `list_open_orders` | none |
| `cancel_order` | `order_id` |
| `get_trade_journal` | `limit` |
| `get_risk_limits` | none |

## Stocks & ETFs

| Skill | Params | Notes |
|---|---|---|
| `buy_stock` / `buy_etf` | `symbol`, `qty` **or** `notional`, `time_in_force` | notional buys whole shares |
| `sell_stock` / `sell_etf` | `symbol`, `qty` (`-1` = all) **or** `notional` | shorting blocked by default |
| `place_stop_loss` | `symbol`, `stop_price`, `qty?` | GTC stop on an existing long |

## Options

All option skills take either `option_symbol` (OCC, e.g. `NVDA261120C00130000`) or
`underlying` + `expiration` + `strike` + `right`, plus `contracts`.

| Skill | Action | Risk requirement |
|---|---|---|
| `buy_option` | buy to open a call/put | premium <= 5% of equity; total long options <= 15%; DTE >= 7 |
| `sell_option_to_close` | sell to close a long option | must hold the contracts |
| `sell_covered_call` | sell to open a call | 100 shares per contract, net of existing short calls |
| `sell_cash_secured_put` | sell to open a put | strike x 100 x contracts in buying power |
| `buy_option_to_close` | buy to close a short option | must be short the contracts |

## Strategies

| Skill | Params | Notes |
|---|---|---|
| `rebalance_portfolio` | `targets` {symbol: weight}, `tolerance` (0.02), `cash_buffer` (0.02), `dry_run` (**default true**) | sells first, then buys; drops held symbols not in targets |
| `momentum_screen` | `symbols`, `lookback_days` | ranks by 60-day and 20-day momentum plus trend; signals only |

## Examples

```bash
python -m trading_agent run buy_stock symbol=NVDA qty=100 reason="AI capex thesis"
python -m trading_agent run place_stop_loss symbol=NVDA stop_price=105
python -m trading_agent run sell_covered_call underlying=NVDA expiration=2026-11-20 strike=135 right=call contracts=1
python -m trading_agent run sell_cash_secured_put option_symbol=SPY261120P00540000 contracts=1 limit_price=6.10
python -m trading_agent run rebalance_portfolio targets='{"VTI":0.5,"VXUS":0.15,"AGG":0.25}'
python -m trading_agent run rebalance_portfolio targets='{"VTI":0.5,"VXUS":0.15,"AGG":0.25}' dry_run=false
python -m trading_agent run momentum_screen symbols='["XLK","XLE","XLF","XLV","XLY"]'
```
