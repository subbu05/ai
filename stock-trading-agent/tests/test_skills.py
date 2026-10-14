from trading_agent.skills import deny_all


def run(registry, ctx, name, **kw):
    return registry.get(name).run(ctx, **kw)


def test_every_skill_has_valid_tool_schema(registry):
    for tool in registry.tools():
        assert tool["input_schema"]["type"] == "object"
        assert tool["description"]
        for req in tool["input_schema"]["required"]:
            assert req in tool["input_schema"]["properties"]


def test_buy_by_notional_then_sell_all(registry, ctx):
    r = run(registry, ctx, "buy_etf", symbol="spy", notional=5000, reason="core")
    assert r["status"] == "filled"
    assert r["order"]["asset_class"] == "etf"
    qty = r["order"]["qty"]
    assert qty == int(5000 // ctx.broker.get_quote("SPY").ask)
    r = run(registry, ctx, "sell_etf", symbol="SPY", qty=-1)
    assert r["status"] == "filled" and r["order"]["qty"] == qty
    assert run(registry, ctx, "get_positions")["count"] == 0


def test_dry_run_sends_nothing(registry, ctx):
    r = run(registry, ctx, "buy_stock", symbol="AAPL", qty=5, dry_run=True)
    assert r["status"] == "preview_only"
    assert ctx.broker.get_position("AAPL") is None


def test_declined_by_approver(registry, ctx):
    ctx.approver = deny_all
    assert run(registry, ctx, "buy_stock", symbol="AAPL", qty=1)["status"] == "declined_by_user"


def test_invalid_inputs(registry, ctx):
    assert run(registry, ctx, "buy_stock", symbol="AAPL")["status"] == "invalid"
    assert run(registry, ctx, "buy_stock", symbol="AAPL", qty=1, order_type="limit")["status"] == "invalid"
    assert run(registry, ctx, "sell_stock", symbol="AAPL", qty=-1)["status"] == "invalid"


def test_covered_call_flow(registry, ctx):
    assert run(registry, ctx, "buy_stock", symbol="NVDA", qty=100)["status"] == "filled"
    chain = run(registry, ctx, "get_option_chain", underlying="NVDA", right="call", min_delta=0.2, max_delta=0.35)
    sym = chain["contracts"][0]["symbol"]
    r = run(registry, ctx, "sell_covered_call", option_symbol=sym, contracts=1, reason="income")
    assert r["status"] == "filled", r
    assert ctx.broker.get_position(sym).qty == -1
    r = run(registry, ctx, "buy_option_to_close", option_symbol=sym, contracts=1)
    assert r["status"] == "filled"
    assert ctx.broker.get_position(sym) is None


def test_covered_call_skill_refuses_puts(registry, ctx):
    r = run(registry, ctx, "sell_covered_call", underlying="AAPL", expiration="2030-01-18",
            strike=200, right="put")
    assert r["status"] == "invalid"


def test_long_option_round_trip(registry, ctx):
    chain = run(registry, ctx, "get_option_chain", underlying="SPY", right="put")
    sym = chain["contracts"][3]["symbol"]
    assert run(registry, ctx, "buy_option", option_symbol=sym, contracts=2)["status"] == "filled"
    assert run(registry, ctx, "sell_option_to_close", option_symbol=sym, contracts=2)["status"] == "filled"


def test_rebalance_dry_run_then_execute(registry, ctx):
    targets = {"VTI": 0.5, "AGG": 0.3}
    plan = run(registry, ctx, "rebalance_portfolio", targets=targets)
    assert plan["dry_run"] and {t["symbol"] for t in plan["trades"]} == {"VTI", "AGG"}
    assert run(registry, ctx, "get_positions")["count"] == 0
    ctx.risk.limits.max_order_notional = 1e9
    done = run(registry, ctx, "rebalance_portfolio", targets=targets, dry_run=False)
    assert all(t["result"] == "filled" for t in done["trades"])
    weights = {p["symbol"]: p["weight"] for p in run(registry, ctx, "get_positions")["positions"]}
    assert abs(weights["VTI"] - 0.5) < 0.02 and abs(weights["AGG"] - 0.3) < 0.02


def test_rebalance_rejects_over_allocation(registry, ctx):
    assert run(registry, ctx, "rebalance_portfolio", targets={"VTI": 0.9, "AGG": 0.2})["status"] == "invalid"


def test_momentum_screen(registry, ctx):
    r = run(registry, ctx, "momentum_screen", symbols=["SPY", "QQQ", "TLT"])
    assert len(r["ranked"]) == 3
    assert r["ranked"][0]["score"] >= r["ranked"][-1]["score"]


def test_journal_records_events(registry, ctx):
    run(registry, ctx, "buy_stock", symbol="AAPL", qty=1)
    run(registry, ctx, "buy_stock", symbol="AAPL", qty=10_000)
    events = [e["event"] for e in ctx.journal.tail(10)]
    assert events == ["proposed", "submitted", "proposed", "risk_rejected"]
