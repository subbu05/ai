# Trading account credentials (secure local config)

All broker and API credentials live in **one local file outside the repository**:

```
~/.config/stock-trading-agent/accounts.toml      (override with TRADING_AGENT_SECRETS=/path)
```

It is never committed: by default it isn't inside the project folder at all, and the code
refuses to use it if it ends up somewhere git could pick it up.

## Set it up

```bash
python -m trading_agent secrets init                  # creates the file (chmod 600, folder chmod 700)
python -m trading_agent secrets set alpaca.api_key_id      # prompts without echoing
python -m trading_agent secrets set alpaca.api_secret_key
python -m trading_agent secrets set webull.app_key
python -m trading_agent secrets set webull.app_secret
python -m trading_agent secrets set robinhood.mcp_token
python -m trading_agent secrets set anthropic.api_key
python -m trading_agent secrets check                 # masked view + safety checks
python -m trading_agent secrets install-hook          # git pre-commit hook that blocks secrets
```

Typing secrets at the prompt keeps them out of your shell history. For scripts, pipe them in
with `--stdin`.

### Settings

| Setting | Exported as | Notes |
|---|---|---|
| `agent.trading_mode` | `TRADING_MODE` | `paper`, `alpaca-paper`, `alpaca-live` |
| `anthropic.api_key` | `ANTHROPIC_API_KEY` | Claude agent |
| `alpaca.api_key_id` / `alpaca.api_secret_key` | `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | built-in Alpaca broker and Alpaca MCP |
| `alpaca.paper_trade` | `ALPACA_PAPER_TRADE` | `false` = live (MCP) |
| `webull.app_key` / `webull.app_secret` | `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` | Webull MCP |
| `webull.region_id` / `webull.environment` | `WEBULL_REGION_ID` / `WEBULL_ENVIRONMENT` | `uat` = sandbox, `prod` = live |
| `robinhood.mcp_token` / `robinhood.account_number` | `ROBINHOOD_MCP_TOKEN` / `ROBINHOOD_ACCOUNT_NUMBER` | Robinhood Agentic Trading MCP |
| `market_data.provider` | `MARKET_DATA` | live price source: `yahoo`, `finnhub`, `alpaca`, `simulated`, or a chain like `finnhub,yahoo` |
| `finnhub.api_key` | `FINNHUB_API_KEY` | free key from finnhub.io |
| `fidelity.mcp_command` / `fidelity.mcp_args` | `FIDELITY_MCP_COMMAND` / `FIDELITY_MCP_ARGS` | unofficial server only |

See [`config/accounts.example.toml`](../config/accounts.example.toml) for the layout.

### OS keychain (optional)

```bash
pip install keyring
python -m trading_agent secrets set alpaca.api_secret_key --keyring
```

The secret goes into the macOS Keychain, Windows Credential Manager or Secret Service. The
file then only holds `keyring:alpaca.api_secret_key`. Any value can also be `env:SOME_VAR` to
read another environment variable.

## Guarantees

| Check | When | Result |
|---|---|---|
| File permissions | every load | refused unless owner-only (`chmod 600`) |
| Inside a git work tree | every load, and on `init` | refused unless git-ignored and not already tracked |
| `.gitignore` | always | ignores `.env*`, `accounts.toml`, `*.local.toml`, `*secrets*.toml/json`, `*.pem`, `*.key`, Webull's `conf/` token folder, `data/`, `reports/` |
| Pre-commit hook | on `git commit` (after `install-hook`) | blocks secret files and content that looks like keys (`sk-ant-…`, `ALPACA_API_SECRET_KEY=…`, private keys, …) |
| Masking | `secrets check` | keys are shown as `PK****67` |

**Precedence:** real environment variables, then the accounts file, then `.env`. `.env` still
works for non-secret settings, but the accounts file is the recommended home for credentials.

Things that never contain credentials: the trade journal, the fills ledger, the price log and
the dashboard. Broker MCP arguments are journaled, but they're order details (symbol, qty,
price, and for Robinhood the account number), not keys.
