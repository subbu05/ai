---
name: watchlist
description: Manage the stock watchlist - add or remove tickers, set custom labels, group and filter by label, choose which tickers profit protection monitors - and open the web UI for click-to-trade. Use when the user mentions a watchlist, labels or tags for stocks, grouping or filtering tickers, or wants a UI to buy from.
---

# Watchlist

Run from `stock-trading-agent/`.

- See it: `python -m trading_agent watch list --group` (or `--label <name>` to filter)
- Add: `python -m trading_agent watch add NVDA --label Tech --label AI` (`--no-monitor` = track only)
- Relabel: `python -m trading_agent watch label JPM Dividend Financials`
- Monitor on/off: `python -m trading_agent watch monitor XOM off`
- Remove: `python -m trading_agent watch remove TSLA` (this never sells anything)

For the visual version, where you click a ticker to buy, run `python -m trading_agent ui`. It
prints a local link with a session token. Tell the user to open that link and keep it private.
Don't start it with `--monitor` on a live account unless the user asks.
