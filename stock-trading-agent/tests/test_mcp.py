"""MCP bridge tests against an in-process fake broker MCP server (no network)."""

import asyncio
import json

import mcp_types as types
import pytest
from mcp import Client
from mcp.server.lowlevel import Server

from trading_agent.mcp_bridge import McpHub, connect_servers
from trading_agent.mcp_bridge import guard
from trading_agent.mcp_bridge.config import McpServerConfig, MissingEnv, load_mcp_servers, selected_servers
from trading_agent.mcp_bridge.server import build_server
from trading_agent.mcp_bridge.skills import register_server
from trading_agent.skills import SkillRegistry, confirm_none


def fake_broker_server(calls: list):
    tools = [
        types.Tool(name="get_account_info", description="Account balances",
                   input_schema={"type": "object", "properties": {}}),
        types.Tool(name="place_stock_order", description="Place a stock order",
                   input_schema={"type": "object", "properties": {
                       "symbol": {"type": "string"}, "qty": {"type": "number"},
                       "side": {"type": "string"}, "limit_price": {"type": "number"}},
                       "required": ["symbol", "qty", "side"]}),
        types.Tool(name="place_option_order", description="Place an option order",
                   input_schema={"type": "object", "properties": {
                       "symbol": {"type": "string"}, "quantity": {"type": "string"},
                       "price": {"type": "string"}}}),
        types.Tool(name="create_watchlist", description="Create a watchlist",
                   input_schema={"type": "object", "properties": {"name": {"type": "string"}}}),
    ]

    async def on_list_tools(ctx, params):
        return types.ListToolsResult(tools=tools)

    async def on_call_tool(ctx, params):
        calls.append((params.name, dict(params.arguments or {})))
        payload = {"cash": 1000.0} if params.name == "get_account_info" else {"order_id": "abc", "status": "accepted"}
        return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(payload))])

    return Server("fake-broker", on_list_tools=on_list_tools, on_call_tool=on_call_tool)


@pytest.fixture
def hub():
    h = McpHub(call_timeout=10, connect_timeout=20)
    yield h
    h.close()


def _connect(hub, ctx, calls, **cfg_kw):
    cfg = McpServerConfig(name="fake", transport="stdio", command="unused", **cfg_kw)
    tools = hub.connect(cfg, target=fake_broker_server(calls))
    reg = SkillRegistry()
    register_server(reg, hub, cfg, tools)
    return reg


# ------------------------------------------------------------------ guard / config
def test_classify():
    cfg = McpServerConfig("x", "stdio", "c")
    assert guard.classify("get_account_info", cfg) == guard.READ
    assert guard.classify("review_equity_order", cfg) == guard.READ
    assert guard.classify("preview_stock_order", cfg) == guard.READ
    assert guard.classify("place_stock_order", cfg) == guard.TRADE
    assert guard.classify("cancel_order_by_id", cfg) == guard.TRADE
    assert guard.classify("exercise_option", cfg) == guard.TRADE
    assert guard.classify("create_watchlist", cfg) == guard.WRITE
    forced = McpServerConfig("x", "stdio", "c", trade_tools=["^create_watchlist$"])
    assert guard.classify("create_watchlist", forced) == guard.TRADE


def test_estimate_notional_and_symbols():
    assert guard.estimate_notional("place_stock_order", {"qty": 10, "limit_price": 50}) == 500
    assert guard.estimate_notional("place_option_order", {"quantity": "2", "price": "1.5"}) == 300
    assert guard.estimate_notional("place_equity_order", {"dollar_amount": "250"}) == 250
    assert guard.estimate_notional("place_stock_order", {"qty": 10}) is None
    assert guard.extract_symbols({"symbol": "aapl"}) == {"AAPL"}
    assert guard.extract_symbols({"legs": [{"symbol": "NVDA261120C00130000"}]}) == {"NVDA"}


def test_env_expansion_and_live_detection(monkeypatch):
    cfg = McpServerConfig("alpaca", "stdio", "uvx", args=["srv", "${OPT:-}"],
                          env={"K": "${MY_KEY}", "PAPER": "${MY_PAPER:-true}"}, live_if_env={"PAPER": "false"})
    monkeypatch.delenv("MY_KEY", raising=False)
    with pytest.raises(MissingEnv):
        cfg.resolved()
    monkeypatch.setenv("MY_KEY", "k1")
    r = cfg.resolved()
    assert r.env == {"K": "k1", "PAPER": "true"} and r.args == ["srv"] and not r.live
    monkeypatch.setenv("MY_PAPER", "false")
    assert cfg.resolved().live


def test_shipped_config_parses(monkeypatch):
    servers = load_mcp_servers()
    assert {"alpaca", "webull", "robinhood", "fidelity"} <= set(servers)
    assert servers["robinhood"].live and servers["fidelity"].read_only and servers["fidelity"].unofficial
    assert selected_servers(servers, "") == []  # nothing enabled by default
    assert [s.name for s in selected_servers(servers, "alpaca,webull")] == ["alpaca", "webull"]
    with pytest.raises(ValueError):
        selected_servers(servers, "etrade")


def test_live_server_needs_ack(hub):
    reg = SkillRegistry()
    cfg = McpServerConfig("rh", "http", url="https://example.invalid/mcp", live=True)
    [status] = connect_servers(reg, hub, [cfg], live_ack=False)
    assert status.status == "skipped" and "live" in status.detail
    assert reg.names() == []


def test_missing_credentials_skip(hub, monkeypatch):
    monkeypatch.delenv("NOPE_KEY", raising=False)
    cfg = McpServerConfig("w", "stdio", "uvx", env={"K": "${NOPE_KEY}"})
    [status] = connect_servers(SkillRegistry(), hub, [cfg])
    assert status.status == "skipped" and "NOPE_KEY" in status.detail


# ------------------------------------------------------------------ bridged tools
def test_tools_registered_with_prefix_and_kind(hub, ctx):
    reg = _connect(hub, ctx, [])
    assert reg.names() == ["fake__create_watchlist", "fake__get_account_info",
                           "fake__place_option_order", "fake__place_stock_order"]
    assert reg.get("fake__place_stock_order").places_orders
    assert reg.get("fake__place_stock_order").description.startswith("[TRADES]")
    assert reg.get("fake__get_account_info").input_schema["type"] == "object"


def test_read_tool_passes_through(hub, ctx):
    calls = []
    reg = _connect(hub, ctx, calls)
    out = reg.get("fake__get_account_info").run(ctx)
    assert out["status"] == "ok" and out["result"] == {"cash": 1000.0}
    assert calls == [("get_account_info", {})]


def test_trade_tool_guarded_approved_and_journaled(hub, ctx):
    calls = []
    reg = _connect(hub, ctx, calls)
    out = reg.get("fake__place_stock_order").run(ctx, symbol="AAPL", qty=10, side="buy", limit_price=200)
    assert out["status"] == "ok" and calls[-1][0] == "place_stock_order"
    events = [e["event"] for e in ctx.journal.tail(5)]
    assert events == ["mcp_proposed", "mcp_result"]


def test_trade_over_notional_rejected(hub, ctx):
    calls = []
    reg = _connect(hub, ctx, calls)
    out = reg.get("fake__place_stock_order").run(ctx, symbol="AAPL", qty=1000, side="buy", limit_price=200)
    assert out["status"] == "rejected_by_guard" and calls == []


def test_option_multiplier_in_guard(hub, ctx):
    ctx.risk.limits.max_order_notional = 1000
    calls = []
    reg = _connect(hub, ctx, calls)
    out = reg.get("fake__place_option_order").run(ctx, symbol="SPY261120P00540000", quantity="2", price="6")
    assert out["status"] == "rejected_by_guard"  # 2 x 6 x 100 = 1200 > 1000


def test_blocked_symbol_and_kill_switch(hub, ctx, limits):
    calls = []
    reg = _connect(hub, ctx, calls)
    ctx.risk.limits.blocked_symbols = ["TSLA"]
    assert reg.get("fake__place_stock_order").run(ctx, symbol="TSLA", qty=1, side="buy",
                                                  limit_price=10)["status"] == "rejected_by_guard"
    open(limits.kill_switch_file, "w").close()
    assert reg.get("fake__create_watchlist").run(ctx, name="x")["status"] == "rejected_by_guard"
    assert calls == []


def test_declined_by_user(hub, ctx):
    calls = []
    reg = _connect(hub, ctx, calls)
    ctx.confirm_action = confirm_none
    out = reg.get("fake__place_stock_order").run(ctx, symbol="AAPL", qty=1, side="buy", limit_price=10)
    assert out["status"] == "declined_by_user" and calls == []


def test_read_only_hides_account_changing_tools(hub, ctx):
    reg = _connect(hub, ctx, [], read_only=True)
    assert reg.names() == ["fake__get_account_info"]


# ------------------------------------------------------------------ our MCP server
def test_serving_our_skills_over_mcp(ctx, registry):
    server = build_server(ctx, registry)

    async def go():
        async with Client(server) as client:
            listed = await client.list_tools()
            names = {t.name for t in listed.tools}
            buy = next(t for t in listed.tools if t.name == "buy_stock")
            quote = await client.call_tool("get_quote", {"symbols": ["SPY"]})
            preview = await client.call_tool("buy_stock", {"symbol": "AAPL", "qty": 1, "dry_run": True})
            bad = await client.call_tool("no_such_tool", {})
            return names, buy, quote, preview, bad

    names, buy, quote, preview, bad = asyncio.run(go())
    assert names == set(registry.names())
    assert buy.annotations.destructive_hint and not buy.annotations.read_only_hint
    assert "SPY" in json.loads(quote.content[0].text)["quotes"]
    assert json.loads(preview.content[0].text)["status"] == "preview_only"
    assert bad.is_error


def test_stdio_round_trip_against_our_own_server(hub, ctx, tmp_path):
    """Real subprocess + stdio transport: the same path used for `uvx alpaca-mcp-server`."""
    import sys

    from trading_agent.config import PROJECT_ROOT

    cfg = McpServerConfig("self", "stdio", sys.executable, args=["-m", "trading_agent", "mcp", "serve"],
                          env={"PYTHONPATH": str(PROJECT_ROOT), "TRADING_MODE": "paper",
                               "PAPER_STATE_FILE": str(tmp_path / "acct.json"),
                               "JOURNAL_FILE": str(tmp_path / "j.jsonl")})
    reg = SkillRegistry()
    [status] = connect_servers(reg, hub, [cfg])
    assert status.status == "connected", status.detail
    assert "self__buy_etf" in reg.names()
    out = reg.get("self__buy_etf").run(ctx, symbol="SPY", qty=2, reason="e2e")
    assert out["status"] == "ok" and out["result"]["status"] == "filled"
    positions = reg.get("self__get_positions").run(ctx)["result"]["positions"]
    assert positions[0]["symbol"] == "SPY" and positions[0]["qty"] == 2
