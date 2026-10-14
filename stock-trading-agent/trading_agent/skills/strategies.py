"""Multi-step strategy skills built on the primitive skills."""

from __future__ import annotations

import math

from ..indicators import summarize
from ..models import AssetClass, Order, OrderType, Side
from .base import Skill, SkillContext, SkillRegistry, schema
from .equity import KNOWN_ETFS


def rebalance_portfolio(ctx: SkillContext, targets: dict[str, float], tolerance: float = 0.02,
                        cash_buffer: float = 0.02, dry_run: bool = True) -> dict:
    """Move stock/ETF holdings toward target weights. Sells first, then buys."""
    total = sum(targets.values())
    if total > 1 - cash_buffer + 1e-9:
        return {"status": "invalid", "error": f"target weights sum to {total:.2%}; must be <= {1 - cash_buffer:.0%}"}
    targets = {s.upper(): w for s, w in targets.items()}
    account = ctx.broker.get_account()
    equity = account.equity
    holdings = {p.symbol: p for p in ctx.broker.get_positions() if p.asset_class != AssetClass.OPTION}

    plan = []
    for sym in sorted(set(targets) | set(holdings)):
        target_w = targets.get(sym, 0.0)
        price = ctx.broker.get_quote(sym).last
        held = holdings[sym].qty if sym in holdings else 0.0
        current_w = held * price / equity if equity else 0
        if abs(current_w - target_w) < tolerance and not (target_w == 0 and held > 0):
            continue
        delta_shares = math.floor((target_w * equity) / price) - held
        if target_w == 0:
            delta_shares = -held
        if abs(delta_shares) < 1:
            continue
        plan.append({"symbol": sym, "current_weight": round(current_w, 4), "target_weight": target_w,
                     "side": "buy" if delta_shares > 0 else "sell", "qty": abs(delta_shares), "price": price})

    plan.sort(key=lambda r: r["side"] != "sell")  # sells first to free cash
    results = []
    for row in plan:
        ac = AssetClass.ETF if row["symbol"] in KNOWN_ETFS else AssetClass.STOCK
        order = Order(row["symbol"], float(row["qty"]), Side(row["side"]), ac, OrderType.MARKET,
                      reason=f"rebalance {row['current_weight']:.1%} -> {row['target_weight']:.1%}")
        results.append({**row, "result": ctx.execute_order(order, dry_run=dry_run)["status"]})
    return {"equity": round(equity, 2), "dry_run": dry_run, "trades": results,
            "note": "Re-run with dry_run=false to execute." if dry_run else None}


def momentum_screen(ctx: SkillContext, symbols: list[str], lookback_days: int = 120) -> dict:
    """Rank symbols by trend/momentum. Signals only; never trades."""
    rows = []
    for s in symbols:
        ind = summarize(ctx.broker.get_history(s, lookback_days))
        score = 0.0
        if ind["mom_60d"] is not None:
            score += ind["mom_60d"] * 2
        if ind["mom_20d"] is not None:
            score += ind["mom_20d"]
        if ind["trend"] == "up":
            score += 0.05
        elif ind["trend"] == "down":
            score -= 0.05
        rsi = ind["rsi14"]
        signal = "hold"
        if ind["trend"] == "up" and rsi is not None and rsi < 70:
            signal = "buy_candidate"
        elif ind["trend"] == "down" or (rsi is not None and rsi > 80):
            signal = "avoid_or_trim"
        rows.append({"symbol": s.upper(), "score": round(score, 4), "signal": signal, **ind})
    rows.sort(key=lambda r: r["score"], reverse=True)
    return {"ranked": rows, "disclaimer": "Heuristic signals, not investment advice."}


def register(reg: SkillRegistry) -> None:
    reg.register(Skill(
        "rebalance_portfolio",
        "Rebalance stock/ETF holdings to target weights (fractions of equity, e.g. {\"VTI\":0.6,\"AGG\":0.3}). "
        "Symbols held but not in targets are sold. dry_run defaults to TRUE: review the plan, then re-run "
        "with dry_run=false to execute.",
        schema({
            "targets": {"type": "object", "additionalProperties": {"type": "number", "minimum": 0, "maximum": 1}},
            "tolerance": {"type": "number", "minimum": 0, "maximum": 0.5},
            "cash_buffer": {"type": "number", "minimum": 0, "maximum": 0.5},
            "dry_run": {"type": "boolean", "default": True},
        }, ["targets"]),
        rebalance_portfolio, places_orders=True, tags=["strategy", "etf"]))
    reg.register(Skill(
        "momentum_screen",
        "Rank a list of symbols by momentum/trend with RSI and volatility. Read-only signals.",
        schema({"symbols": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "lookback_days": {"type": "integer", "minimum": 70, "maximum": 500}}, ["symbols"]),
        momentum_screen, tags=["strategy", "market"]))
