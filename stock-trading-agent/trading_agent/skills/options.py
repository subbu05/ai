"""Option order skills: long calls/puts, covered calls, cash-secured puts, closing trades."""

from __future__ import annotations

from datetime import date

from ..models import AssetClass, OptionContract, OptionRight, Order, OrderType, PositionIntent, Side
from .base import ORDER_FIELDS, Skill, SkillContext, SkillRegistry, schema

CONTRACT_FIELDS = {
    "option_symbol": {"type": "string", "description": "OCC symbol, e.g. AAPL261120C00230000. "
                      "Alternatively give underlying + expiration + strike + right."},
    "underlying": {"type": "string"},
    "expiration": {"type": "string", "description": "YYYY-MM-DD"},
    "strike": {"type": "number"},
    "right": {"type": "string", "enum": ["call", "put"]},
    "contracts": {"type": "integer", "minimum": 1, "description": "Number of contracts (x100 shares)."},
}


def _contract(option_symbol=None, underlying=None, expiration=None, strike=None, right=None) -> OptionContract:
    if option_symbol:
        return OptionContract.from_occ(option_symbol)
    if not (underlying and expiration and strike and right):
        raise ValueError("give option_symbol or all of underlying, expiration, strike, right")
    return OptionContract(underlying.upper(), date.fromisoformat(expiration), float(strike), OptionRight(right))


def _option_order(side: Side, intent: PositionIntent, force_right: OptionRight | None = None):
    def handler(ctx: SkillContext, contracts: int = 1, order_type: str = "limit",
                limit_price: float | None = None, reason: str | None = None, dry_run: bool = False,
                **contract_args) -> dict:
        try:
            c = _contract(**contract_args)
        except (ValueError, TypeError) as e:
            return {"status": "invalid", "error": str(e)}
        if force_right and c.right != force_right:
            return {"status": "invalid", "error": f"this skill only trades {force_right.value}s"}
        if order_type == "limit" and limit_price is None:
            limit_price = ctx.broker.get_quote(c.occ_symbol).mid  # default to the mid
        order = Order(symbol=c.occ_symbol, qty=float(contracts), side=side, asset_class=AssetClass.OPTION,
                      order_type=OrderType(order_type), limit_price=limit_price, intent=intent,
                      reason=reason)
        out = ctx.execute_order(order, dry_run=dry_run)
        out["contract"] = {"underlying": c.underlying, "expiration": c.expiration.isoformat(),
                           "strike": c.strike, "right": c.right.value}
        return out
    return handler


def _fields(required_extra: list[str] | None = None) -> dict:
    f = dict(CONTRACT_FIELDS)
    f.update(ORDER_FIELDS)
    f["order_type"] = {**ORDER_FIELDS["order_type"], "default": "limit"}
    f["limit_price"] = {"type": "number", "description": "Per-share premium. Defaults to the mid price."}
    return f


def register(reg: SkillRegistry) -> None:
    reg.register(Skill(
        "buy_option",
        "Buy to open a call or put (long premium; max loss = premium paid). Limit order at mid by default.",
        schema(_fields()), _option_order(Side.BUY, PositionIntent.OPEN),
        places_orders=True, tags=["trade", "options"]))
    reg.register(Skill(
        "sell_option_to_close",
        "Sell to close a long option position you already own.",
        schema(_fields()), _option_order(Side.SELL, PositionIntent.CLOSE),
        places_orders=True, tags=["trade", "options"]))
    reg.register(Skill(
        "sell_covered_call",
        "Sell to open a call against shares you own (100 shares per contract required).",
        schema(_fields()), _option_order(Side.SELL, PositionIntent.OPEN, OptionRight.CALL),
        places_orders=True, tags=["trade", "options", "income"]))
    reg.register(Skill(
        "sell_cash_secured_put",
        "Sell to open a put fully secured by cash (strike x 100 per contract must be available).",
        schema(_fields()), _option_order(Side.SELL, PositionIntent.OPEN, OptionRight.PUT),
        places_orders=True, tags=["trade", "options", "income"]))
    reg.register(Skill(
        "buy_option_to_close",
        "Buy to close a short option (e.g. roll or exit a covered call / cash-secured put).",
        schema(_fields()), _option_order(Side.BUY, PositionIntent.CLOSE),
        places_orders=True, tags=["trade", "options"]))
