"""Buy every ticker under a watchlist label with an equal dollar split.

    amount = $10,000, label "Tech" = AAPL, MSFT, NVDA  ->  $3,333.33 per ticker

Two pricing modes:
* ``market``: market orders; shares = floor(allocation / ask)
* ``limit``:  limit orders at ``discount_pct`` (default 5%) below the current price;
               shares = floor(allocation / limit price). They only fill if the price
               falls to the limit, so they may rest unfilled.

Whole shares only; what can't be spent is reported as leftover. Each leg is a normal
``buy_stock`` / ``buy_etf`` order, so the risk engine, approvals and journal apply per
leg. Planning is read-only; ``execute_basket`` places the orders.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

from .skills.base import SkillContext, SkillRegistry
from .skills.equity import KNOWN_ETFS
from .watchlist import Watchlist, normalize_label

DEFAULT_DISCOUNT = 0.05


@dataclass
class Leg:
    symbol: str
    allocation: float
    market_price: float | None = None
    order_price: float | None = None      # ask for market, limit price for limit
    limit_price: float | None = None
    qty: int = 0
    est_cost: float = 0.0
    status: str = "planned"               # planned | skipped | preview_only | filled | new | rejected_by_risk ...
    note: str = ""
    risk: dict | None = None


@dataclass
class BasketPlan:
    label: str
    amount: float
    order_type: str
    discount_pct: float
    time_in_force: str
    per_ticker: float
    legs: list[Leg] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def est_total(self) -> float:
        return round(sum(l.est_cost for l in self.legs if l.qty > 0 and l.status not in ("skipped",)), 2)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["est_total"] = self.est_total
        d["leftover"] = round(self.amount - self.est_total, 2)
        d["tickers"] = len(self.legs)
        d["orders"] = sum(1 for l in self.legs if l.qty > 0 and l.status != "skipped")
        return d


def plan_basket(ctx: SkillContext, watchlist: Watchlist, label: str, amount: float,
                order_type: str = "market", discount_pct: float = DEFAULT_DISCOUNT,
                time_in_force: str = "day", skip_held: bool = False) -> BasketPlan:
    label = normalize_label(label)
    if order_type not in ("market", "limit"):
        raise ValueError("order_type must be 'market' or 'limit'")
    if time_in_force not in ("day", "gtc"):
        raise ValueError("time_in_force must be 'day' or 'gtc'")
    if not 0 < amount <= 10_000_000:
        raise ValueError("amount must be a positive dollar amount")
    if order_type == "limit" and not 0 < discount_pct < 0.5:
        raise ValueError("discount_pct must be between 0 and 0.5 (e.g. 0.05 for 5%)")
    symbols = [i.symbol for i in watchlist.filter([label])]
    if not symbols:
        raise ValueError(f"no tickers have the label {label!r}")

    held = {p.symbol for p in ctx.broker.get_positions() if p.qty > 0}
    candidates = [s for s in symbols if not (skip_held and s in held)]
    plan = BasketPlan(label, round(amount, 2), order_type, discount_pct if order_type == "limit" else 0.0,
                      time_in_force, 0.0)
    for s in symbols:
        if s not in candidates:
            plan.legs.append(Leg(s, 0.0, status="skipped", note="already held"))
    if not candidates:
        return plan

    per = math.floor(amount / len(candidates) * 100) / 100
    plan.per_ticker = per
    for sym in candidates:
        leg = Leg(sym, per)
        try:
            q = ctx.broker.get_quote(sym)
        except Exception as e:
            leg.status, leg.note = "skipped", f"no quote: {e}"
            plan.legs.append(leg)
            continue
        leg.market_price = round(q.last or q.mid, 2)
        if order_type == "market":
            leg.order_price = round(q.ask or q.last, 2)
        else:
            leg.limit_price = round(leg.market_price * (1 - discount_pct), 2)
            leg.order_price = leg.limit_price
        if not leg.order_price or leg.order_price <= 0:
            leg.status, leg.note = "skipped", "no usable price"
        else:
            leg.qty = int(per // leg.order_price)
            leg.est_cost = round(leg.qty * leg.order_price, 2)
            if leg.qty == 0:
                leg.status, leg.note = "skipped", f"${per:,.2f} is less than one share at ${leg.order_price:,.2f}"
        plan.legs.append(leg)
    return plan


def _order_args(plan: BasketPlan, leg: Leg) -> tuple[str, dict]:
    skill = "buy_etf" if leg.symbol in KNOWN_ETFS else "buy_stock"
    args = {"symbol": leg.symbol, "qty": float(leg.qty), "order_type": plan.order_type,
            "time_in_force": plan.time_in_force,
            "reason": f"basket '{plan.label}': ${plan.per_ticker:,.2f} per ticker"
                      + (f", limit {plan.discount_pct:.0%} below market" if plan.order_type == "limit" else "")}
    if plan.order_type == "limit":
        args["limit_price"] = leg.limit_price
    return skill, args


class BasketError(ValueError):
    pass


def run_basket(ctx: SkillContext, registry: SkillRegistry, plan: BasketPlan, dry_run: bool = True) -> BasketPlan:
    """Risk-check (dry_run) or place every leg. Legs are independent: one rejection
    doesn't stop the others.

    Per-leg checks can't see the other legs, and resting limit orders don't reduce buying
    power until they fill, so the basket total is checked against buying power up front."""
    buying_power = ctx.broker.get_account().buying_power
    if plan.est_total > buying_power:
        msg = (f"basket needs about ${plan.est_total:,.2f} but buying power is ${buying_power:,.2f}; "
               "lower the amount")
        if not dry_run:
            raise BasketError(msg)
        plan.warnings.append(msg)
    if plan.order_type == "limit":
        plan.warnings.append(f"limit orders {plan.discount_pct:.0%} below market fill only if the price drops "
                             "that far; unfilled orders stay open" + (" until cancelled" if plan.time_in_force == "gtc"
                                                                      else " for the day"))
    if not dry_run:
        ctx.journal.record("basket_start", label=plan.label, amount=plan.amount, order_type=plan.order_type,
                           discount_pct=plan.discount_pct, legs=[l.symbol for l in plan.legs if l.qty > 0])
    for leg in plan.legs:
        if leg.status == "skipped" or leg.qty <= 0:
            continue
        skill, args = _order_args(plan, leg)
        out = registry.get(skill).run(ctx, **args, dry_run=dry_run)
        leg.status = out.get("status", "error")
        leg.risk = out.get("risk")
        if out.get("error"):
            leg.note = out["error"]
        elif leg.risk and leg.risk.get("reasons"):
            leg.note = "; ".join(leg.risk["reasons"])
        order = out.get("order") or {}
        if order.get("filled_avg_price"):
            leg.est_cost = round(order["filled_avg_price"] * order.get("filled_qty", leg.qty), 2)
    return plan
