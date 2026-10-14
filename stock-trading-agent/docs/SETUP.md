# Setup

## Requirements

- Python 3.11+
- `anthropic` (only needed for the Claude agent: `ask`, `chat` and `autopilot` commands)

```bash
cd stock-trading-agent
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
pytest
```

## 1. Local paper trading (default)

No keys needed. `TRADING_MODE=paper` uses the built-in simulator. Account state is kept in
`data/paper_account.json`. Delete that file to reset to `PAPER_STARTING_CASH`.

## 2. Claude agent

Get an API key from the Claude Console and put it in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
AGENT_MODEL=claude-opus-5-5
AGENT_EFFORT=high          # low | medium | high | xhigh | max
```

Try it: `python -m trading_agent ask "Summarise my account and positions"`.

## 3. Alpaca paper trading (real market data)

1. Create an account at alpaca.markets and generate **paper** API keys.
2. Turn on options trading for the paper account if you want options.
3. In `.env`:
   ```
   TRADING_MODE=alpaca-paper
   ALPACA_API_KEY_ID=...
   ALPACA_API_SECRET_KEY=...
   ```
4. Check it with `python -m trading_agent account`.

## 4. Live trading (real money)

1. Work through the checklist in [RISK_MANAGEMENT.md](RISK_MANAGEMENT.md#before-you-go-live).
2. Generate **live** Alpaca keys and set `TRADING_MODE=alpaca-live`.
3. Every command now needs `--i-understand-live-trading`, and every order needs approval:
   ```bash
   python -m trading_agent --i-understand-live-trading account
   ```

## Scheduling autopilot

`autopilot` loops on its own (`--interval` seconds). You can also run a single pass from
cron, which is more robust:

```cron
# 10:00 ET on weekdays, one pass, paper account
0 10 * * 1-5  cd /path/to/stock-trading-agent && .venv/bin/python -m trading_agent --yes autopilot --task-file config/autopilot_task.md --iterations 1 >> data/autopilot.log 2>&1
```

Edit `config/autopilot_task.md` to change what the agent does on each run.
