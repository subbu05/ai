# Daily price tracking, profit protection and P&L charts

## Profit-protection rule

> On any day, if a stock is in profit and its price starts falling (by a set 1–10%), sell **all**
> of it while it's still in profit. Worst case, sell at the price I bought. Never at a loss.

For each **stock and ETF** position (options are never touched), every check works like this:

1. **Track**: record the price; keep today's open, high, low and last, and the highest price
   since the position went into profit.
2. **Arm**: the rule only applies once the price has been at least `min_profit_pct` (default 1%)
   above your average cost. A position that was never in profit is left alone, so this isn't a
   stop-loss (use `place_stop_loss` for that).
3. **Trigger level** = `max(reference × (1 − drop_pct), average cost)`
   - `reference` = today's high (`day_high`, default) or the peak since in profit (`peak`)
   - `drop_pct` = your 1–10% (default 3%; anything outside 1–10% is rejected)
4. **Sell** the whole position when `price <= trigger`:
   - **still in profit**: limit sell at `max(bid, cost)`, which fills immediately at a profit
   - **already at or below cost** (it fell through between checks): a limit sell that rests at
     your **cost**. It fills when the price gets back to break-even, and it never sells lower.

Example, cost $100, `drop_pct = 3%`:

| Today's high | Trigger | Price now | Action |
|---|---|---|---|
| $100.50 | n/a | $99.00 | hold: never 1% in profit |
| $110.00 | $106.70 | $108.00 | hold: in profit, above trigger |
| $110.00 | $106.70 | $106.50 | **sell all now** at ~$106.40 (+6.4%) |
| $101.50 | $100.00 (floor) | $99.00 | **resting sell at $100.00** (break-even) |

### Configure: `[profit_protect]` in `config/risk.toml`

```toml
[profit_protect]
enabled = true
drop_pct = 0.03            # 0.01 .. 0.10
reference = "day_high"     # or "peak"
min_profit_pct = 0.01
include_etfs = true
symbols = []               # only these (empty = all holdings)
exclude_symbols = []
auto_sell = true           # paper / alpaca-paper: sell without asking
auto_sell_live = false     # live account: asks y/N unless you set this to true
respect_market_hours = true
```

### Run it

```bash
python -m trading_agent monitor                      # every 5 min until stopped
python -m trading_agent monitor --interval 900       # every 15 min
python -m trading_agent monitor --dry-run            # report decisions, never sell
python -m trading_agent monitor --once               # single pass (for cron)
python -m trading_agent monitor --simulate --ignore-hours --interval 1 --iterations 50   # paper demo
```

Cron, every 15 minutes during US market hours (times in ET):

```cron
CRON_TZ=America/New_York
*/15 9-15 * * 1-5  cd /path/to/stock-trading-agent && .venv/bin/python -m trading_agent monitor --once >> data/monitor.log 2>&1
```

Each pass also saves an equity snapshot and syncs fills into the P&L ledger. On Alpaca the
monitor skips checks while the market is closed.

The agent can use it too: the `track_prices` skill (a dry run by default) and
`get_price_tracking`.

**Things to know**
- Checks are periodic, so a fast drop can pass several % between two checks. The cost floor is
  what guarantees no loss. For tighter protection, check more often.
- Limit orders aren't guaranteed to fill: a sell at the bid can miss if the price moves first.
  The next check sees the working order and won't place a duplicate.
- After a sell, the rule disarms for that symbol until you buy it again.
- On a live account with `auto_sell_live = false`, an unattended monitor waits for your y/N
  answer. Run it in a terminal you watch, or turn on `auto_sell_live` deliberately.

## P&L tracking

Fills are the source of truth. They're synced from the broker (paper fills, or Alpaca's
account-activity feed) into `data/fills.jsonl`, then matched FIFO per symbol. Long and short
positions are both handled; options count ×100 and commissions are subtracted.

```bash
python -m trading_agent pnl        # realized profit, realized loss, net, win rate, by symbol/day, unrealized
```

Broker MCP accounts (Webull, Robinhood, …) aren't in the ledger yet. Their fills come back in
each broker's own format.

## Charts: `python -m trading_agent report`

This writes `reports/pnl_dashboard.html`, one self-contained file that works offline (git-ignored):

- **Net realized P&L**, plus tiles for realized profit, realized loss, win rate and unrealized P&L
- **Cumulative realized P&L** (line)
- **Daily realized P&L** (profit / loss columns)
- **Realized P&L by symbol** (profit / loss bars)
- **Account equity** (from monitor snapshots)
- **Tracked daily prices**: per-holding daily close against average cost, with sells marked
- **Closed trades** table

Every chart has hover tooltips and a table view, and follows your light/dark setting.

Try it with simulated data (writes to `reports/demo_data/`, not your real `data/`):

```bash
python scripts/demo_monitor.py --days 30
open reports/demo_dashboard.html
```
