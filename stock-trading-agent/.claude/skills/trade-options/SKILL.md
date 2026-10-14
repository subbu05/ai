---
name: trade-options
description: Trade listed options (long calls/puts, covered calls, cash-secured puts, closing and rolling) through the trading agent CLI. Use when the user mentions calls, puts, strikes, expirations, premium, covered calls, wheel strategy or hedging with puts.
---

# Trade options

Run from `stock-trading-agent/`. Supported: long calls and puts, covered calls, cash-secured
puts, buy/sell to close, and rolls (close, then open). Naked selling and multi-leg spreads are
**not** supported.

1. **Look at the chain.** Filter by right and delta:
   ```bash
   python -m trading_agent run get_option_chain underlying=NVDA right=call min_delta=0.20 max_delta=0.30
   python -m trading_agent run get_option_chain underlying=SPY right=put expiration=2026-11-20
   ```
   Pick a contract and note its OCC `symbol`, bid/ask and delta.
2. **Check eligibility:**
   - Covered call: `positions` must show >= 100 shares per contract.
   - Cash-secured put: `account` buying power >= strike x 100 x contracts.
   - Long option: premium x 100 x contracts <= 5% of equity; expiry >= 7 days out.
3. **Preview, then execute** with a limit order (it defaults to the mid):
   ```bash
   python -m trading_agent run sell_covered_call option_symbol=<OCC> contracts=1 reason="income" dry_run=true
   python -m trading_agent run sell_covered_call option_symbol=<OCC> contracts=1 reason="income"
   python -m trading_agent run sell_cash_secured_put option_symbol=<OCC> contracts=1 limit_price=<px>
   python -m trading_agent run buy_option option_symbol=<OCC> contracts=2 reason="<thesis>"
   python -m trading_agent run sell_option_to_close option_symbol=<OCC> contracts=2
   python -m trading_agent run buy_option_to_close option_symbol=<OCC> contracts=1
   ```
4. **Explain the risk** in plain terms: max loss, breakeven, and assignment risk for short options.

Always state the contract in words ("1 NVDA Nov-20 $135 call") before executing, and get
the user's confirmation.
