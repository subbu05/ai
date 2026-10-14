---
name: pnl-report
description: Report trading profit and loss - realized profit, realized loss, net, win rate, P&L by symbol and day, unrealized P&L - and build the HTML P&L dashboard with charts. Use when the user asks how much they made or lost, for P&L, performance, or charts.
---

# P&L report

Run from `stock-trading-agent/`.

```bash
python -m trading_agent pnl       # JSON summary (syncs fills from the broker first)
python -m trading_agent report    # writes reports/pnl_dashboard.html
```

Summarize for the user:
- Net realized P&L, total realized profit, total realized loss, win rate, number of closed trades
- Best and worst symbols (`by_symbol`), best and worst days (`by_day`)
- Unrealized P&L on open positions

Then point them to `reports/pnl_dashboard.html`. It has charts for cumulative and daily realized
P&L, P&L by symbol, the equity curve and tracked daily prices against cost. If there are no
fills yet, suggest `python scripts/demo_monitor.py --days 30` to see a demo dashboard.
