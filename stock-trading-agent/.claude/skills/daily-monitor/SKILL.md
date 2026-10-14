---
name: daily-monitor
description: Track daily prices of stock/ETF holdings and apply the profit-protection rule (sell the whole position while still in profit after a 1-10% drop from the day's high; never below cost). Use when the user asks to watch, track or protect their stocks' gains, or to start or check the daily monitor.
---

# Daily price monitor and profit protection

Run from `stock-trading-agent/`.

1. Show the current rule settings: `sed -n '/\[profit_protect\]/,$p' config/risk.toml`.
   Confirm `drop_pct` (must be 0.01-0.10) and `reference` with the user. Edit the file if they
   want different values.
2. Preview what would happen right now (no orders):
   ```bash
   python -m trading_agent monitor --once --dry-run --ignore-hours
   ```
   Explain each line: `hold` (and its trigger price), `sell_now` (in profit, would sell all),
   `sell_at_cost` (break-even resting sell).
3. Start it only when the user asks:
   ```bash
   python -m trading_agent monitor --interval 300
   ```
   For a live account, explain that `auto_sell_live = false` means it will ask y/N before each sell.
4. Check the state later: `python -m trading_agent run get_price_tracking` and
   `python -m trading_agent journal -n 20` (look for `profit_protect_trigger`).

Never set `auto_sell_live = true` or pass `--i-understand-live-trading` unless the user
explicitly asks for it in this conversation.
