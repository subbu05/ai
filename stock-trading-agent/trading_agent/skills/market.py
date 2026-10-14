"""Read-only market data skills."""

from __future__ import annotations

from datetime import date

from ..indicators import summarize
from ..models import OptionRight
from ..options_math import black_scholes, years_to_expiry
from .base import Skill, SkillContext, SkillRegistry, schema


def get_quote(ctx: SkillContext, symbols: list[str]) -> dict:
    out = {}
    for s in symbols:
        q = ctx.broker.get_quote(s)
        out[q.symbol] = {"bid": q.bid, "ask": q.ask, "last": q.last, "mid": q.mid}
    return {"quotes": out}


def get_price_history(ctx: SkillContext, symbol: str, days: int = 120) -> dict:
    closes = ctx.broker.get_history(symbol, days)
    return {"symbol": symbol.upper(), "days": len(closes), "indicators": summarize(closes),
            "recent_closes": [round(c, 2) for c in closes[-10:]]}


def get_option_chain(
    ctx: SkillContext,
    underlying: str,
    expiration: str | None = None,
    right: str | None = None,
    min_delta: float | None = None,
    max_delta: float | None = None,
    implied_vol: float = 0.25,
) -> dict:
    exp = date.fromisoformat(expiration) if expiration else None
    spot = ctx.broker.get_quote(underlying).last
    rows = []
    for contract, q in ctx.broker.get_option_chain(underlying, exp):
        if right and contract.right.value != right:
            continue
        g = black_scholes(spot, contract.strike, years_to_expiry(contract.expiration),
                          implied_vol, contract.right)
        if min_delta is not None and abs(g.delta) < min_delta:
            continue
        if max_delta is not None and abs(g.delta) > max_delta:
            continue
        rows.append({
            "symbol": contract.occ_symbol, "right": contract.right.value,
            "strike": contract.strike, "expiration": contract.expiration.isoformat(),
            "bid": q.bid, "ask": q.ask, "mid": q.mid,
            "delta": round(g.delta, 3), "theta": round(g.theta, 3),
        })
    rows.sort(key=lambda r: (r["expiration"], r["right"], r["strike"]))
    return {"underlying": underlying.upper(), "spot": spot, "contracts": rows[:60],
            "note": "Greeks are model estimates using the supplied implied_vol."}


def register(reg: SkillRegistry) -> None:
    reg.register(Skill(
        "get_quote", "Get latest bid/ask/last for one or more stock, ETF or OCC option symbols.",
        schema({"symbols": {"type": "array", "items": {"type": "string"}, "minItems": 1}}, ["symbols"]),
        get_quote, tags=["market"]))
    reg.register(Skill(
        "get_price_history",
        "Daily price history with indicators (SMA20/50, RSI14, 20d volatility, momentum).",
        schema({"symbol": {"type": "string"}, "days": {"type": "integer", "minimum": 20, "maximum": 500}},
               ["symbol"]),
        get_price_history, tags=["market"]))
    reg.register(Skill(
        "get_option_chain",
        "List option contracts for an underlying with bid/ask and estimated delta/theta. "
        "Filter by right (call/put), expiration (YYYY-MM-DD) and absolute delta range.",
        schema({
            "underlying": {"type": "string"},
            "expiration": {"type": "string", "description": "YYYY-MM-DD; default ~30 days out"},
            "right": {"type": "string", "enum": [r.value for r in OptionRight]},
            "min_delta": {"type": "number", "minimum": 0, "maximum": 1},
            "max_delta": {"type": "number", "minimum": 0, "maximum": 1},
            "implied_vol": {"type": "number", "minimum": 0.01, "maximum": 3},
        }, ["underlying"]),
        get_option_chain, tags=["market", "options"]))
