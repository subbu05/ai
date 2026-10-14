---
name: rebalance-etf
description: Rebalance a portfolio to target ETF/stock weights (e.g. 60/40, three-fund portfolio). Use when the user gives a target allocation or asks to rebalance.
---

# Rebalance to target weights

Run from `stock-trading-agent/`.

1. Confirm the targets as fractions of equity that sum to <= 0.98 (2% cash buffer). Example
   three-fund portfolio: `{"VTI":0.5,"VXUS":0.2,"AGG":0.28}`.
2. **Plan** (dry run is the default):
   ```bash
   python -m trading_agent run rebalance_portfolio targets='{"VTI":0.5,"VXUS":0.2,"AGG":0.28}' tolerance=0.02
   ```
   Show the user the trades table: symbol, current weight, target weight, side, qty.
   Holdings that aren't in `targets` will be **sold**. Point this out.
3. **Execute** only after explicit confirmation:
   ```bash
   python -m trading_agent run rebalance_portfolio targets='{"VTI":0.5,"VXUS":0.2,"AGG":0.28}' dry_run=false
   ```
4. Run `positions` again and report the new weights. If any leg came back `rejected_by_risk`,
   explain why (often `max_order_notional`) and ask how to proceed.

Sells run before buys so cash is available. Options positions are ignored by the rebalancer.
