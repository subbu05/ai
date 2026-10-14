"""Agent loop tests with a fake Anthropic client (no network)."""

from types import SimpleNamespace as NS

from trading_agent.agent import TradingAgent


class FakeMessages:
    def __init__(self, scripted):
        self.scripted = list(scripted)
        self.calls = []

    def create(self, **kwargs):
        # Snapshot: the agent keeps appending to the same list after the call.
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return self.scripted.pop(0)


def _client(responses):
    msgs = FakeMessages(responses)
    return NS(beta=NS(messages=msgs)), msgs


def tool_use(id_, name, input_):
    return NS(type="tool_use", id=id_, name=name, input=input_)


def text(t):
    return NS(type="text", text=t)


def test_agent_executes_tools_and_returns_text(ctx, registry):
    client, msgs = _client([
        NS(stop_reason="tool_use", content=[
            tool_use("t1", "get_account", {}),
            tool_use("t2", "buy_etf", {"symbol": "SPY", "qty": 3, "reason": "test"}),
        ]),
        NS(stop_reason="end_turn", content=[text("Bought 3 SPY.")]),
    ])
    agent = TradingAgent(ctx, registry, client=client)
    assert agent.ask("buy 3 spy") == "Bought 3 SPY."
    assert ctx.broker.get_position("SPY").qty == 3

    first = msgs.calls[0]
    assert first["model"] == "claude-opus-5-5"
    assert {t["name"] for t in first["tools"]} == set(registry.names())
    # Both tool results returned together in one user message
    results = msgs.calls[1]["messages"][-1]
    assert results["role"] == "user" and len(results["content"]) == 2
    assert {r["tool_use_id"] for r in results["content"]} == {"t1", "t2"}


def test_tool_errors_are_reported_not_raised(ctx, registry):
    client, msgs = _client([
        NS(stop_reason="tool_use", content=[tool_use("t1", "no_such_skill", {})]),
        NS(stop_reason="end_turn", content=[text("sorry")]),
    ])
    TradingAgent(ctx, registry, client=client).ask("x")
    result = msgs.calls[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "unknown skill" in result["content"]


def test_risk_rejection_flows_back_to_model(ctx, registry):
    client, msgs = _client([
        NS(stop_reason="tool_use", content=[tool_use("t1", "buy_stock", {"symbol": "AAPL", "qty": 10_000})]),
        NS(stop_reason="end_turn", content=[text("Rejected by risk.")]),
    ])
    TradingAgent(ctx, registry, client=client).ask("buy a lot of aapl")
    assert "rejected_by_risk" in msgs.calls[1]["messages"][-1]["content"][0]["content"]
    assert ctx.broker.get_position("AAPL") is None


def test_refusal_handled(ctx, registry):
    client, _ = _client([NS(stop_reason="refusal", content=[])])
    assert "declined" in TradingAgent(ctx, registry, client=client).ask("x")
