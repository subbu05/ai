# Risk management

Every order goes through `RiskManager.check` before it can reach a broker, whether it comes
from the CLI, a strategy skill or the Claude agent. Limits live in
[`config/risk.toml`](../config/risk.toml). You can point `RISK_CONFIG` at another file.
Unknown keys are an error, so a typo can't silently disable a limit.

## Evaluation order

1. **Kill switch.** If `kill_switch_file` exists, every order is rejected, including
   closing trades. `python -m trading_agent kill` creates it and `resume` removes it.
2. **Basic validation.** Quantity must be positive, and option quantities must be whole contracts.
3. **Reducing trades bypass the remaining limits.** Selling at most what you're long, or
   buying back at most what you're short, is always allowed (with a warning) so you can de-risk
   even after hitting the daily loss limit.
4. **Opening trades** must pass every rule below.

## Rules for opening trades

| Rule | Setting | Default |
|---|---|---|
| Symbol allow-list (by underlying) | `allowed_symbols` | empty = all |
| Symbol block-list | `blocked_symbols` | empty |
| Daily loss stop (vs. start-of-day equity) | `max_daily_loss_pct` | 3% |
| Max distinct positions | `max_open_positions` | 20 |
| Max $ per buy order | `max_order_notional` | $25,000 |
| Buying power | n/a | must cover the order |
| Single stock position cap | `max_position_pct` | 20% of equity |
| Single ETF position cap | `max_etf_position_pct` | 60% of equity |
| Short stock | `allow_short_stock` | off |
| Option min days to expiry | `min_option_dte` | 7 |
| Premium per option buy | `max_option_premium_pct` | 5% of equity |
| Total long option exposure | `max_total_option_pct` | 15% of equity |
| Naked option selling | `allow_naked_options` | off: calls must be covered by shares, puts by cash |

Warnings that don't block: market orders when the bid/ask spread is wider than 5%, and
bypassed limits on reducing trades.

## Human approval

After risk approval, the order goes to the **approver**:
- CLI and agent: an interactive `y/N` prompt that shows side, size, price, estimated notional,
  reason and warnings.
- `--yes` or `REQUIRE_APPROVAL=false` turns on auto-approval, **paper and alpaca-paper only**.
  In `alpaca-live` mode, `--yes` makes the CLI exit, and `REQUIRE_APPROVAL=false` is ignored.

## Before you go live

- [ ] Run in `paper`, then `alpaca-paper`, for at least a few weeks. Review `data/trade_journal.jsonl`.
- [ ] Tighten `config/risk.toml` to your real account size. Fill in `allowed_symbols`.
- [ ] Confirm the options approval level on your brokerage account.
- [ ] Keep `REQUIRE_APPROVAL=true`. Don't run `autopilot` live unattended.
- [ ] Know where the kill switch is: `python -m trading_agent kill`.
- [ ] Remember that simulated fills are optimistic. Real fills face slippage, partial fills,
      halts, early assignment and pattern-day-trader rules, which this code doesn't model.
