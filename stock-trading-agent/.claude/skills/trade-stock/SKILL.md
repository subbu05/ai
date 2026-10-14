---
name: trade-stock
description: Buy or sell individual stocks (market, limit, stop-loss) through the trading agent CLI with pre-trade risk checks. Use when the user asks to buy, sell, trim, exit or protect a stock position.
---

# Trade a stock

Run every command from the `stock-trading-agent/` directory.

1. **Check the context first.**
   ```bash
   python -m trading_agent account
   python -m trading_agent positions
   python -m trading_agent quote <SYMBOL>
   python -m trading_agent run get_price_history symbol=<SYMBOL>
   ```
2. **Size the trade.** Use `qty=<shares>` or `notional=<dollars>`. Stay inside the limits shown by
   `python -m trading_agent run get_risk_limits` (single stock <= 20% of equity by default).
3. **Preview it.** Add `dry_run=true` and show the user the risk result.
   ```bash
   python -m trading_agent run buy_stock symbol=<SYMBOL> qty=<N> reason="<why>" dry_run=true
   ```
4. **Execute only after the user confirms.** Drop `dry_run`. For wide spreads, use
   `order_type=limit limit_price=<px>`.
   ```bash
   python -m trading_agent run buy_stock symbol=<SYMBOL> qty=<N> reason="<why>"
   python -m trading_agent run sell_stock symbol=<SYMBOL> qty=-1 reason="exit"   # sell all
   python -m trading_agent run place_stop_loss symbol=<SYMBOL> stop_price=<px>
   ```
5. **Report back** the status, fill price and resulting position.

Rules: never retry a `rejected_by_risk` order in smaller pieces to get around a limit. Never
pass `--yes` or `--i-understand-live-trading` unless the user explicitly asks for it in this
conversation.
