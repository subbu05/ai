# Architecture

## Components

```
                ┌──────────────┐     ┌──────────────────────┐
  CLI / chat ──►│ TradingAgent │────►│ Claude Messages API  │
  autopilot     │  (agent.py)  │◄────│ (tool use)           │
                └──────┬───────┘     └──────────────────────┘
                       │ tool calls
                       ▼
                ┌──────────────┐
  CLI `run` ───►│ SkillRegistry│  market · portfolio · equity · options · strategies
                └──────┬───────┘
                       │ order skills call
                       ▼
            ┌───────────────────────────┐
            │ SkillContext.execute_order│
            │  1. RiskManager.check     │──► rejected_by_risk
            │  2. dry_run?              │──► preview_only
            │  3. approver(order)       │──► declined_by_user
            │  4. broker.submit_order   │──► filled / new / rejected
            │  5. TradeJournal.record   │   (at every step)
            └─────────────┬─────────────┘
                          ▼
                ┌──────────────────┐
                │ Broker interface │── PaperBroker (simulator)
                └──────────────────┘── AlpacaBroker (REST)
```

### `models.py`
Plain dataclasses: `Order`, `Position`, `Account`, `Quote`, `OptionContract` (with OCC
symbol encode/decode). Enums for side, order type, asset class and option right.

### `brokers/`
- `base.Broker` is the abstract interface: account, positions, quotes, option chain, submit,
  cancel, list orders, history.
- `paper.PaperBroker` is a fully offline simulator. Equity prices are a seeded random walk
  around realistic anchors. Options are priced with Black-Scholes. Market orders fill at
  bid/ask. Limit orders rest unless they're marketable (option limits at or through the mid
  fill). Commissions are $0.65 per contract. State persists to JSON.
- `alpaca.AlpacaBroker` is a standard-library HTTP client for Alpaca's trading and market-data
  APIs, including options (`position_intent` buy/sell to open/close).

### `risk.py`
`RiskManager.check(order) -> RiskDecision`. It's stateless apart from reading the broker.
See [RISK_MANAGEMENT.md](RISK_MANAGEMENT.md).

### `skills/`
A `Skill` is `name + description + JSON schema + handler(ctx, **kwargs) -> dict`. The same
object is exposed:
- to the CLI (`python -m trading_agent run <skill> key=value ...`)
- to Claude as a tool (`Skill.to_tool()`)

Handlers return JSON-serialisable dicts. Order skills return a `status` of `filled`, `new`,
`preview_only`, `rejected_by_risk`, `declined_by_user`, `broker_error` or `invalid`.

### `agent.py`
A manual tool-use loop against the Messages API:
- All registered skills are sent as tools. The system prompt sets the trading rules.
- Parallel tool calls run in order, and all their results go back in a single user message.
- Tool exceptions are returned to Claude as `is_error` results, so the agent can recover.
- It handles `refusal`, `pause_turn` and `max_tokens` stop reasons. Tool turns per request
  are capped (`max_turns=25`).
- It uses adaptive thinking, a configurable effort level, and server-side refusal fallbacks.

### `mcp_bridge/`
- `config.py` loads `config/mcp_servers.toml`, expands `${VAR}` / `${VAR:-default}` and works
  out whether a server is live.
- `hub.py` (`McpHub`) runs one asyncio loop in a background thread. It keeps one long-lived
  `mcp.Client` per server (stdio subprocess or streamable HTTP) and gives the synchronous code
  a `call(server, tool, args)` method.
- `guard.py` classifies each remote tool as read, trade or write, and checks trade/write calls
  (kill switch, symbol lists, estimated order value).
- `skills.py` registers each remote tool as a skill named `<server>__<tool>`. Non-read calls go
  guard, then `SkillContext.confirm_action`, then the call, then the journal.
- `server.py` serves the skill registry as an MCP server (`mcp serve`).

See [MCP.md](MCP.md).

### `journal.py`
Append-only JSONL. Events: `proposed`, `risk_rejected`, `declined`, `submitted`,
`broker_error`, `canceled`, `autopilot_error`.

## Adding a skill

```python
# trading_agent/skills/my_skills.py
from .base import Skill, SkillContext, SkillRegistry, schema
from ..models import AssetClass, Order, Side

def buy_the_dip(ctx: SkillContext, symbol: str, drop_pct: float = 0.05, notional: float = 1000,
                dry_run: bool = False) -> dict:
    closes = ctx.broker.get_history(symbol, 30)
    if closes[-1] > max(closes) * (1 - drop_pct):
        return {"status": "no_signal"}
    qty = notional // ctx.broker.get_quote(symbol).ask
    order = Order(symbol.upper(), qty, Side.BUY, AssetClass.STOCK, reason=f"{drop_pct:.0%} dip")
    return ctx.execute_order(order, dry_run=dry_run)   # ALWAYS go through execute_order

def register(reg: SkillRegistry) -> None:
    reg.register(Skill(
        "buy_the_dip", "Buy a stock if it is down drop_pct from its 30-day high.",
        schema({"symbol": {"type": "string"}, "drop_pct": {"type": "number"},
                "notional": {"type": "number"}, "dry_run": {"type": "boolean"}}, ["symbol"]),
        buy_the_dip, places_orders=True, tags=["strategy"]))
```

Then add `my_skills` to `default_registry()` in `skills/__init__.py`. The CLI and the agent
pick it up automatically.

**Rule:** never call `ctx.broker.submit_order` directly from a skill. That would skip risk
checks, approval and the journal.

## Adding a broker

Subclass `brokers.base.Broker`, implement its abstract methods, and wire it into
`brokers.create_broker`. Map the broker's statuses onto `OrderStatus`. Make sure option
positions report `AssetClass.OPTION` and OCC symbols, so the risk engine can work out
coverage.
