"""Account / portfolio skills."""

from __future__ import annotations

from .base import Skill, SkillContext, SkillRegistry, schema


def get_account(ctx: SkillContext) -> dict:
    a = ctx.broker.get_account()
    return {"broker": ctx.broker.name, "mode": ctx.settings.trading_mode, **a.to_dict(),
            "kill_switch": ctx.risk.kill_switch_active()}


def get_positions(ctx: SkillContext) -> dict:
    positions = ctx.broker.get_positions()
    equity = ctx.broker.get_account().equity or 1
    rows = []
    for p in positions:
        d = p.to_dict()
        d["weight"] = round(p.market_value / equity, 4)
        rows.append(d)
    return {"positions": rows, "count": len(rows)}


def list_open_orders(ctx: SkillContext) -> dict:
    return {"orders": [o.to_dict() for o in ctx.broker.list_orders("open")]}


def cancel_order(ctx: SkillContext, order_id: str) -> dict:
    ctx.broker.cancel_order(order_id)
    ctx.journal.record("canceled", order_id=order_id)
    return {"canceled": order_id}


def get_trade_journal(ctx: SkillContext, limit: int = 20) -> dict:
    return {"entries": ctx.journal.tail(limit)}


def get_risk_limits(ctx: SkillContext) -> dict:
    return {"limits": ctx.risk.limits.__dict__}


def register(reg: SkillRegistry) -> None:
    empty = schema({})
    reg.register(Skill("get_account", "Cash, equity, buying power, day P&L and options level.",
                       empty, get_account, tags=["portfolio"]))
    reg.register(Skill("get_positions", "All open positions with market value, P&L and portfolio weight.",
                       empty, get_positions, tags=["portfolio"]))
    reg.register(Skill("list_open_orders", "Working (unfilled) orders.", empty, list_open_orders,
                       tags=["portfolio"]))
    reg.register(Skill("cancel_order", "Cancel a working order by id.",
                       schema({"order_id": {"type": "string"}}, ["order_id"]), cancel_order,
                       tags=["portfolio"]))
    reg.register(Skill("get_trade_journal", "Recent entries from the audit journal.",
                       schema({"limit": {"type": "integer", "minimum": 1, "maximum": 200}}),
                       get_trade_journal, tags=["portfolio"]))
    reg.register(Skill("get_risk_limits", "The active pre-trade risk limits.", empty, get_risk_limits,
                       tags=["portfolio"]))
