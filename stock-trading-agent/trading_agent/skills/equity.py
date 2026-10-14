"""Stock and ETF order skills."""

from __future__ import annotations

import math

from ..models import AssetClass, Order, OrderType, Side, TimeInForce
from .base import ORDER_FIELDS, Skill, SkillContext, SkillRegistry, schema

# Common ETFs, used to tag positions correctly in paper mode.
KNOWN_ETFS = {
    "SPY", "VOO", "IVV", "VTI", "QQQ", "IWM", "DIA", "AGG", "BND", "TLT", "IEF", "SHY", "GLD",
    "SLV", "VEA", "VXUS", "VWO", "EFA", "EEM", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU",
    "XLB", "XLRE", "XLC", "VNQ", "SCHD", "VIG", "ARKK", "SMH", "SOXX", "HYG", "LQD", "TQQQ", "SQQQ",
}


def _resolve_qty(ctx: SkillContext, symbol: str, side: Side, qty: float | None,
                 notional: float | None, limit_price: float | None) -> float:
    if qty is not None and notional is not None:
        raise ValueError("pass either qty or notional, not both")
    if qty == -1 and side == Side.SELL:  # sell everything
        pos = ctx.broker.get_position(symbol)
        if not pos or pos.qty <= 0:
            raise ValueError(f"no long {symbol} position to sell")
        return pos.qty
    if qty is not None:
        return qty
    if notional is None:
        raise ValueError("qty or notional is required")
    q = ctx.broker.get_quote(symbol)
    px = limit_price or (q.ask if side == Side.BUY else q.bid) or q.last
    shares = math.floor(notional / px)
    if shares < 1:
        raise ValueError(f"notional {notional} buys less than one share at {px}")
    return float(shares)


def _equity_order(asset_class: AssetClass, side: Side):
    def handler(ctx: SkillContext, symbol: str, qty: float | None = None, notional: float | None = None,
                order_type: str = "market", limit_price: float | None = None,
                time_in_force: str = "day", reason: str | None = None, dry_run: bool = False) -> dict:
        symbol = symbol.upper()
        try:
            quantity = _resolve_qty(ctx, symbol, side, qty, notional, limit_price)
        except ValueError as e:
            return {"status": "invalid", "error": str(e)}
        if order_type == "limit" and limit_price is None:
            return {"status": "invalid", "error": "limit_price required for limit orders"}
        ac = AssetClass.ETF if (asset_class == AssetClass.ETF or symbol in KNOWN_ETFS) else asset_class
        order = Order(symbol=symbol, qty=quantity, side=side, asset_class=ac,
                      order_type=OrderType(order_type), time_in_force=TimeInForce(time_in_force),
                      limit_price=limit_price, reason=reason)
        return ctx.execute_order(order, dry_run=dry_run)
    return handler


def place_stop_loss(ctx: SkillContext, symbol: str, stop_price: float, qty: float | None = None,
                    reason: str | None = None, dry_run: bool = False) -> dict:
    symbol = symbol.upper()
    pos = ctx.broker.get_position(symbol)
    if not pos or pos.qty <= 0:
        return {"status": "invalid", "error": f"no long {symbol} position to protect"}
    order = Order(symbol=symbol, qty=qty or pos.qty, side=Side.SELL, asset_class=pos.asset_class,
                  order_type=OrderType.STOP, time_in_force=TimeInForce.GTC, stop_price=stop_price,
                  reason=reason or "protective stop")
    return ctx.execute_order(order, dry_run=dry_run)


def _props(buy: bool) -> dict:
    qty_desc = "Number of shares." + ("" if buy else " Use -1 to sell the entire position.")
    return {
        "symbol": {"type": "string"},
        "qty": {"type": "number", "description": qty_desc},
        "notional": {"type": "number", "description": "Dollar amount instead of qty (whole shares)."},
        "time_in_force": {"type": "string", "enum": ["day", "gtc"], "default": "day"},
        **ORDER_FIELDS,
    }


def register(reg: SkillRegistry) -> None:
    for asset, label in ((AssetClass.STOCK, "stock"), (AssetClass.ETF, "etf")):
        reg.register(Skill(
            f"buy_{label}",
            f"Buy shares of {'an ETF' if label == 'etf' else 'a stock'} by qty or dollar notional. "
            "Runs pre-trade risk checks; returns the order result.",
            schema(_props(True), ["symbol"]), _equity_order(asset, Side.BUY),
            places_orders=True, tags=["trade", label]))
        reg.register(Skill(
            f"sell_{label}",
            f"Sell shares of {'an ETF' if label == 'etf' else 'a stock'} you hold "
            "(qty, notional, or qty=-1 for all).",
            schema(_props(False), ["symbol"]), _equity_order(asset, Side.SELL),
            places_orders=True, tags=["trade", label]))
    reg.register(Skill(
        "place_stop_loss", "Place a GTC stop-loss sell order to protect an existing long stock/ETF position.",
        schema({"symbol": {"type": "string"}, "stop_price": {"type": "number"},
                "qty": {"type": "number"}, "reason": ORDER_FIELDS["reason"],
                "dry_run": ORDER_FIELDS["dry_run"]}, ["symbol", "stop_price"]),
        place_stop_loss, places_orders=True, tags=["trade", "stock", "etf"]))
