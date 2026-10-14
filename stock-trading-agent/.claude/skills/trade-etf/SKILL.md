---
name: trade-etf
description: Buy or sell ETFs (index funds, sector funds, bond funds) through the trading agent CLI. Use when the user wants to invest a dollar amount in an ETF, add to or trim a fund, or swap one ETF for another.
---

# Trade an ETF

Run from `stock-trading-agent/`.

1. Check `account`, `positions` and `quote <ETF>`.
2. ETFs are usually bought by dollar amount:
   ```bash
   python -m trading_agent run buy_etf symbol=VTI notional=5000 reason="<why>" dry_run=true
   python -m trading_agent run buy_etf symbol=VTI notional=5000 reason="<why>"
   ```
3. Selling:
   ```bash
   python -m trading_agent run sell_etf symbol=VTI notional=2000 reason="trim"
   python -m trading_agent run sell_etf symbol=VTI qty=-1 reason="exit"
   ```
4. To swap funds (e.g. SPY to VOO), sell first, check the fill, then buy with the proceeds.

A single ETF may be up to 60% of equity by default (`max_etf_position_pct`). For
multi-fund target allocations, use the `rebalance-etf` skill instead.
