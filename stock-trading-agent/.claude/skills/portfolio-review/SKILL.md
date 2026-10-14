---
name: portfolio-review
description: Review the trading account - balances, positions, allocation, P&L, open orders, option exposure and recent trades. Use when the user asks how their portfolio is doing, what they own, or for a risk check.
---

# Portfolio review

Run from `stock-trading-agent/`. This skill is read-only and never places orders.

```bash
python -m trading_agent account
python -m trading_agent positions
python -m trading_agent run list_open_orders
python -m trading_agent journal -n 20
python -m trading_agent run get_risk_limits
```

Optionally, check trend and momentum for the holdings:
```bash
python -m trading_agent run momentum_screen symbols='["SYM1","SYM2"]'
```

Summarise for the user:
1. Equity, cash, buying power, day P&L.
2. Positions table: symbol, qty, value, weight, unrealized P&L.
3. Concentration: any position near its cap (stock 20%, ETF 60%).
4. Options: short calls and puts with expiry and strike, and any contracts expiring within 7 days.
5. Open orders and anything the risk engine rejected recently (journal `risk_rejected`).
6. Suggested follow-ups, labelled as suggestions, not advice.
