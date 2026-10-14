# Web UI: watchlist, labels, filters, click-to-trade

```bash
python -m trading_agent ui                 # opens http://127.0.0.1:8765/#token=...
python -m trading_agent ui --monitor       # also start profit protection right away
python -m trading_agent ui --simulate      # paper only: prices move, for trying it out
```

## What you can do

| Area | Actions |
|---|---|
| **Watchlist** | Add a ticker (checked against a live quote), remove it, add a note |
| **Monitoring** | Per-ticker **Monitor** checkbox: when ticked and you hold the stock, the profit-protection rule manages it. Unticked tickers are never sold by the monitor |
| **Labels** | Give tickers any number of your own labels (Tech, Dividend, Long term, …) with **+ label**. **Manage labels** renames or deletes a label everywhere |
| **Group** | **Group by label** shows a section per label, with ticker count, how many you hold and their combined unrealized P&L. A ticker with two labels appears in both. **No grouping** shows one table |
| **Filter** | Label chips (any match), search by ticker or note, **Held only**, **Monitored only**, **In profit**. Your filters are remembered in this browser |
| **Click a ticker** | Opens the trade panel: bid/ask/last, a 90-day price line, trend/RSI/momentum, your position. Choose **Buy/Sell**, **Shares/Dollars**, Market/Limit, then **Preview order**. The preview runs the full risk engine; **Confirm** stays disabled until it passes. Changing anything requires a new preview |
| **Profit protection** | On/off switch for the background monitor, **Preview check** (shows what it would do, sells nothing), **Run check now**. Each row shows its status: *Armed · sells ≤ $X*, *Not in profit yet*, *Watching*, *Not monitored* |
| **Orders** | Open orders with **Cancel**; holdings that aren't on your watchlist, with **Add to watchlist** |

The header shows equity, cash, buying power, day P&L and realized P&L, plus a red **LIVE**
badge and banner on a live account.

## Safety

- **Local only.** The server listens on `127.0.0.1`, so other machines can't connect.
- **Session token.** Each run prints a link with a random token. Every API call must send it,
  and other websites can't, so a malicious page can't place orders through your browser. The
  token is removed from the address bar once the page loads. Don't share the link.
- **Host check** blocks DNS-rebinding. **Strict CSP**: no external scripts, no framing.
- **Same order path as the CLI:** skill, then risk engine, then broker, then trade journal.
  Your **Confirm** click is the approval.
- **Live accounts:** every order also needs the **I understand this uses real money** box ticked.
  The server enforces this too, not just the page. The background monitor only sells on its own
  if `auto_sell_live = true`; otherwise it shows the suggested sell and you place it.
- **Kill switch** (`python -m trading_agent kill`) blocks everything, and the UI shows a banner.

## Command-line equivalents

```bash
python -m trading_agent watch add NVDA --label Tech --label AI
python -m trading_agent watch add XOM --label Dividend --no-monitor
python -m trading_agent watch label JPM Dividend Financials     # replace labels
python -m trading_agent watch monitor XOM on
python -m trading_agent watch list --group
python -m trading_agent watch list --label Dividend
python -m trading_agent watch remove TSLA
```

The Claude agent has the same functions as skills: `watchlist_list`, `watchlist_add`,
`watchlist_remove`.

The watchlist is stored in `data/watchlist.json` (git-ignored). Once it has entries, the monitor
only manages ticked tickers. With no watchlist, it manages every stock/ETF holding as before.
