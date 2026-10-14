# MCP broker integrations

The agent can talk to brokers through **Model Context Protocol (MCP)** servers, alongside its
built-in broker. MCP works in two directions here:

| Direction | What it does | Command |
|---|---|---|
| **Client** | The agent connects to broker MCP servers (Alpaca, Webull, Robinhood, ...) and offers their tools to Claude, behind the MCP guard | `--mcp alpaca,webull chat` |
| **Server** | This project's risk-checked skills are served over MCP, so Claude Code, Claude Desktop or Cursor can use them | `mcp serve` |

## Broker support

| Broker | Official MCP server | Transport | Paper / sandbox | Notes |
|---|---|---|---|---|
| **Alpaca** | Yes: [`alpaca-mcp-server`](https://github.com/alpacahq/alpaca-mcp-server) | stdio (`uvx`) | Yes (default) | Stocks, ETFs, options, crypto. `ALPACA_PAPER_TRADE=false` for live |
| **Webull** | Yes: [`webull-openapi-mcp`](https://pypi.org/project/webull-openapi-mcp/) | stdio (`uvx`) | Yes (`WEBULL_ENVIRONMENT=uat`) | Stocks, ETFs, options. Has its own order value, quantity and symbol limits. 2FA accounts run `uvx webull-openapi-mcp auth` once |
| **Robinhood** | Yes: Agentic Trading, `https://agent.robinhood.com/mcp/trading` | remote HTTP + OAuth | No (real money) | Trades only in a separate Agentic account; every order goes to the Robinhood app for you to approve |
| **Fidelity** | **No** | n/a | n/a | No public retail trading API. Community servers automate a logged-in browser: unofficial and fragile. Off and read-only by default |

All four are defined in [`config/mcp_servers.toml`](../config/mcp_servers.toml). Nothing is
enabled by default.

## Quick start: Alpaca paper via MCP

```bash
pip install uv                      # provides uvx
# .env: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (paper keys), ALPACA_PAPER_TRADE=true
python -m trading_agent mcp servers                 # what's configured and ready
python -m trading_agent mcp tools alpaca            # connect and list tools (read/trade/write)
python -m trading_agent --mcp alpaca run alpaca__get_account_info
python -m trading_agent --mcp alpaca chat           # Claude now sees alpaca__* tools
```

Select servers with `--mcp a,b`, `MCP_SERVERS=a,b` in `.env`, or `enabled = true` in the TOML.

## Webull

```bash
# .env: WEBULL_APP_KEY, WEBULL_APP_SECRET, WEBULL_ENVIRONMENT=uat (sandbox)
uvx webull-openapi-mcp auth                         # only if your account uses 2FA
python -m trading_agent mcp tools webull
python -m trading_agent --mcp webull ask "Preview buying 5 shares of AAPL at a $200 limit"
```

The Webull server enforces its own limits as well (`WEBULL_MAX_ORDER_NOTIONAL_USD`,
`WEBULL_MAX_ORDER_QUANTITY`, `WEBULL_SYMBOL_WHITELIST`). `WEBULL_TOOLSETS=account,market-data`
makes it read-only on the server side.

## Robinhood

Robinhood's server is remote and uses OAuth sign-in. The easiest route is a client that
handles OAuth for you:

```bash
# Claude Code
claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading
# then run /mcp in Claude Code and sign in
```

In Claude Desktop, go to **Settings → Connectors → Add custom connector** and paste the same URL.

To use it from this Python agent, put an OAuth access token in `ROBINHOOD_MCP_TOKEN`. Then:

```bash
python -m trading_agent --i-understand-live-trading --mcp robinhood chat
```

Robinhood orders aren't placed directly. `place_*_order` sends the order to the Robinhood app,
where you approve or decline it. That's on top of this project's own approval prompt.

## Fidelity

Fidelity has **no** official API or MCP server, so there is no supported way to trade a
Fidelity account programmatically. The `fidelity` entry is a placeholder for an MCP server
**you** choose and review. Community projects of this kind drive a headless browser with your
saved session, which means:

- they're not affiliated with or endorsed by Fidelity, and may conflict with its terms of use
- they break when the website changes
- the session file they keep is equivalent to your login

If you still want one, set `FIDELITY_MCP_COMMAND` / `FIDELITY_MCP_ARGS`. The entry is
`read_only = true`, so the agent only gets balances and positions. Change that at your own risk.

## The MCP guard

Broker MCP servers have their own order schemas, so the full risk engine (which works on this
project's `Order` model) can't run on them. Every bridged tool is classified instead:

| Class | How it's detected | Handling |
|---|---|---|
| `read` | `get_*`, `list_*`, `search_*`, `preview_*`, `review_*`, ... or `readOnlyHint` | passed straight through |
| `trade` | names with `place`, `replace`, `cancel`, `close`, `exercise`, `order`, `buy`, `sell`, ... | guard, then approval, then journal |
| `write` | anything else (watchlists, alerts, account settings) | kill switch, then approval, then journal |

Override the classification per server with `trade_tools = ["regex"]` / `read_tools = ["regex"]`.
List the result with `mcp tools <server>`.

For `trade` tools, the guard applies:

- **Kill switch** (`python -m trading_agent kill`) blocks every non-read call.
- **Symbol allow/block lists** from `config/risk.toml`. OCC option symbols map to their underlying.
- **Order value cap**: `qty × price` (× 100 for options) or a `notional` / `dollar_amount`,
  checked against `max_order_notional`. If the value can't be worked out from the arguments, the
  approval prompt says so.
- **Human approval** on every trade and write. `--yes` skips it only for paper and sandbox
  servers, never for live ones.
- **Journal**: `mcp_proposed`, `mcp_rejected`, `mcp_declined` and `mcp_result` events in
  `data/trade_journal.jsonl`.

**Not applied** to broker MCP orders: position caps, options coverage (covered calls /
cash-secured puts), daily loss stop and DTE limits. Use the broker's own controls as well
(Webull's limits, Robinhood's in-app approval, Alpaca paper accounts), or set `read_only = true`.

Live servers (`live = true`, or `live_if_env` matched, e.g. `ALPACA_PAPER_TRADE=false` or
`WEBULL_ENVIRONMENT=prod`) are only connected with `--i-understand-live-trading`, unless they're
read-only.

## Serving this project's skills over MCP

```bash
python -m trading_agent mcp serve
```

This exposes all built-in skills, with risk checks, dry runs and the journal, over stdio.
Order skills are marked `destructiveHint`, so MCP clients ask before calling them. There's no
terminal for a y/N prompt in this mode, so:

- `paper` / `alpaca-paper`: orders that pass the risk engine are executed. The client's
  tool-permission prompt is the human check.
- `alpaca-live`: order skills are declined unless you start the server with
  `--i-understand-live-trading mcp serve --allow-live-orders`.

### Claude Code

[`.mcp.json`](../.mcp.json) in this folder registers `trading-agent`, `alpaca` and `webull`.
Open Claude Code in `stock-trading-agent/` and approve the servers when asked. Credentials come
from your shell environment (`ALPACA_API_KEY_ID`, `WEBULL_APP_KEY`, ...). Add Robinhood with the
`claude mcp add` command above.

### Claude Desktop / Cursor

Copy the entries you want from
[`config/claude_desktop_config.example.json`](../config/claude_desktop_config.example.json) into
your client's config, and fill in absolute paths and keys.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `skipped - missing environment variables: ...` | set them in `.env` |
| `skipped - live account: pass --i-understand-live-trading` | intended; or set `read_only = true` |
| `uvx: not found` | `pip install uv` (or install uv another way) |
| `could not connect ... Connection closed` | the server exited at startup. Run its command by hand to see why (bad keys, no network, missing 2FA auth) |
| Protocol / validation noise on startup | set `protocol = "legacy"` for that server |
