# Stock Trading Agent

An automated trading agent for **stocks, ETFs and options**, built from small composable
**skills**. You can drive it three ways:

1. **Directly**: run any skill from the CLI (`run buy_etf symbol=VTI notional=5000`).
2. **Conversationally**: ask the Claude agent in plain English (`ask "sell a covered call on my NVDA"`).
3. **Automatically**: let the agent run a standing task on a schedule (`autopilot --task-file ...`).

Every order, whoever places it, goes through the same pipeline:

```
skill ──► RiskManager.check ──► human approval ──► broker ──► trade journal
           (hard limits)        (y/N prompt)      (paper / Alpaca)  (JSONL audit log)
```

> **Disclaimer:** This is educational software, not investment advice. Trading, and
> options trading in particular, can lose money fast. Start in paper mode, read
> [docs/RISK_MANAGEMENT.md](docs/RISK_MANAGEMENT.md), and only go live once you understand
> every line that touches your account.

## Quick start (no API keys needed)

```bash
cd stock-trading-agent
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env            # defaults to TRADING_MODE=paper (local simulator)

python -m trading_agent skills                       # list every skill
python -m trading_agent account
python -m trading_agent quote SPY AAPL
python -m trading_agent run buy_etf symbol=VTI notional=10000 reason="core holding"
python -m trading_agent run get_option_chain underlying=NVDA right=call min_delta=0.2 max_delta=0.3
python -m trading_agent positions
python -m trading_agent journal
pytest                                               # 36 offline tests
```

## Using the Claude agent

Set `ANTHROPIC_API_KEY` in `.env` (or run `ant auth login`), then:

```bash
python -m trading_agent ask "What's my allocation? Rebalance to 60% VTI / 30% AGG, show me the plan first."
python -m trading_agent chat
python -m trading_agent autopilot --task-file config/autopilot_task.md --interval 86400
```

The agent uses `claude-opus-5-5` (set `AGENT_MODEL` / `AGENT_EFFORT` to change it) with
adaptive thinking. Server-side refusal fallbacks are turned on. Claude only sees the skills
as tools, so it can't get around the risk engine or the approval prompt.

## Brokers / modes

| `TRADING_MODE` | Broker | Money | Notes |
|---|---|---|---|
| `paper` (default) | Built-in simulator | Fake | Offline, deterministic prices, Black-Scholes option pricing, state saved in `data/` |
| `alpaca-paper` | Alpaca paper API | Fake | Real market data; needs Alpaca keys |
| `alpaca-live` | Alpaca live API | **Real** | Needs `--i-understand-live-trading` on every command; `--yes` auto-approve is disabled |

To add another broker (IBKR, Schwab, Tradier...), implement `trading_agent/brokers/base.py::Broker`.

## Skills

| Category | Skills |
|---|---|
| Market data | `get_quote`, `get_price_history`, `get_option_chain` |
| Portfolio | `get_account`, `get_positions`, `list_open_orders`, `cancel_order`, `get_trade_journal`, `get_risk_limits` |
| Stocks | `buy_stock`, `sell_stock`, `place_stop_loss` |
| ETFs | `buy_etf`, `sell_etf` |
| Options | `buy_option`, `sell_option_to_close`, `sell_covered_call`, `sell_cash_secured_put`, `buy_option_to_close` |
| Strategies | `rebalance_portfolio`, `momentum_screen` |

Full reference: [docs/SKILLS.md](docs/SKILLS.md). Writing your own: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-a-skill).

## Claude Code skills

`.claude/skills/` contains Claude Code skills (`trade-stock`, `trade-etf`, `trade-options`,
`portfolio-review`, `rebalance-etf`). Open Claude Code in this folder and type
`/trade-options sell a covered call on NVDA`, and Claude will drive the same CLI.

## Safety controls

- Paper trading by default. Live mode needs an explicit env var **and** a CLI flag.
- Pre-trade risk limits in [`config/risk.toml`](config/risk.toml): order size, position caps,
  daily loss stop, option premium caps, minimum DTE, no shorting, no naked options, symbol
  allow/block lists.
- **Kill switch**: `python -m trading_agent kill` blocks all trading; `resume` lifts it.
- Closing and reducing trades are always allowed, so you can always get out.
- Every proposal, rejection, approval and fill is written to `data/trade_journal.jsonl`.

## Documentation

- [docs/SETUP.md](docs/SETUP.md): installation, Alpaca setup, going live checklist
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, order pipeline, extending
- [docs/SKILLS.md](docs/SKILLS.md): every skill and its parameters
- [docs/RISK_MANAGEMENT.md](docs/RISK_MANAGEMENT.md): every risk rule and how to tune it
- [docs/OPTIONS.md](docs/OPTIONS.md): supported option strategies and OCC symbols

## Layout

```
stock-trading-agent/
├── trading_agent/
│   ├── agent.py            # Claude tool-use loop
│   ├── cli.py              # command line entry point
│   ├── config.py           # env + risk.toml loading
│   ├── models.py           # Order, Position, OptionContract, ...
│   ├── risk.py             # pre-trade risk engine
│   ├── journal.py          # JSONL audit log
│   ├── indicators.py       # SMA, RSI, volatility, momentum
│   ├── options_math.py     # Black-Scholes + Greeks
│   ├── brokers/            # base interface, paper simulator, Alpaca adapter
│   └── skills/             # market, portfolio, equity, options, strategies
├── config/                 # risk.toml, autopilot_task.md
├── docs/
├── tests/
└── .claude/skills/         # Claude Code skills
```
