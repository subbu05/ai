"""Daily price tracking and the profit-protection sell rule.

The rule, per stock/ETF position (options are never touched):

1. Every check records the price and keeps today's open / high / low / last (and the
   highest price since the position went into profit).
2. The position is **armed** once its price has been at least ``min_profit_pct`` (default 1%)
   above the average cost: it was in profit at some point today, or since the peak.
3. ``trigger = max(reference x (1 - drop_pct), average cost)`` where ``reference`` is today's
   high (``day_high``, the default) or the peak since in profit (``peak``) and ``drop_pct`` is
   between 1% and 10%.
4. If armed and ``price <= trigger``, sell the **whole** position:
   * price still above cost: limit sell at ``max(bid, cost)``. It fills now, in profit.
   * price already at or below cost (it fell through between checks): a resting limit sell at
     **cost**, the "worst case, sell at the price I bought" floor. It never sells below cost.
5. A position that was never in profit is left alone. This rule protects gains; it isn't a
   stop-loss. Use ``place_stop_loss`` for that.

All sells go through ``SkillContext.execute_order`` (risk engine, journal). Whether they're
executed automatically is controlled by ``[profit_protect]`` in config/risk.toml.
"""

from __future__ import annotations

import dataclasses
import json
import math
import os
import tomllib
from dataclasses import dataclass, field, fields
from datetime import date, datetime, timezone
from pathlib import Path

from .config import DEFAULT_RISK_FILE, PROJECT_ROOT
from .models import AssetClass, Order, OrderType, Side, TimeInForce
from .skills.base import SkillContext, auto_approve


@dataclass
class ProfitProtectConfig:
    enabled: bool = True
    drop_pct: float = 0.03              # 1% .. 10%
    reference: str = "day_high"         # "day_high" | "peak"
    min_profit_pct: float = 0.01        # must have been this far above cost to arm
    include_etfs: bool = True
    symbols: list[str] = field(default_factory=list)          # empty = every holding
    exclude_symbols: list[str] = field(default_factory=list)
    auto_sell: bool = True              # execute without a prompt (paper / alpaca-paper)
    auto_sell_live: bool = False        # also execute automatically on a LIVE account
    respect_market_hours: bool = True

    def validate(self) -> "ProfitProtectConfig":
        if not 0.01 <= self.drop_pct <= 0.10:
            raise ValueError(f"profit_protect.drop_pct must be between 0.01 and 0.10, got {self.drop_pct}")
        if self.reference not in ("day_high", "peak"):
            raise ValueError("profit_protect.reference must be 'day_high' or 'peak'")
        if self.min_profit_pct < 0:
            raise ValueError("profit_protect.min_profit_pct must be >= 0")
        return self

    @classmethod
    def load(cls, path: Path | None = None) -> "ProfitProtectConfig":
        path = path or Path(os.getenv("RISK_CONFIG", DEFAULT_RISK_FILE))
        if not path.exists():
            return cls()
        with path.open("rb") as fh:
            data = tomllib.load(fh).get("profit_protect", {})
        unknown = set(data) - {f.name for f in fields(cls)}
        if unknown:
            raise ValueError(f"Unknown profit_protect settings in {path}: {sorted(unknown)}")
        return cls(**data).validate()


@dataclass
class Decision:
    symbol: str
    action: str             # hold | sell_now | sell_at_cost | skip
    price: float
    avg_cost: float
    qty: float
    trigger: float | None
    reference: float | None
    reason: str
    limit_price: float | None = None
    result: str | None = None

    def to_dict(self) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in dataclasses.asdict(self).items()}


def _ceil_cent(x: float) -> float:
    return math.ceil(round(x * 100, 6)) / 100


def evaluate(price: float, bid: float, avg_cost: float, day_high: float, peak: float,
             cfg: ProfitProtectConfig) -> tuple[str, float | None, float | None, str, float | None]:
    """Pure rule. Returns (action, trigger, reference, reason, limit_price)."""
    arm_level = avg_cost * (1 + cfg.min_profit_pct)
    reference = day_high if cfg.reference == "day_high" else peak
    if reference <= arm_level:
        return ("hold", None, reference, "not in profit yet (rule arms once price is above cost)", None)
    trigger = max(reference * (1 - cfg.drop_pct), avg_cost)
    if price > trigger:
        return ("hold", trigger, reference,
                f"in profit; sells if price falls to {trigger:.2f} "
                f"({cfg.drop_pct:.0%} below {cfg.reference.replace('_', ' ')} {reference:.2f}, floor = cost)", None)
    floor = _ceil_cent(avg_cost)
    if price > avg_cost:
        return ("sell_now", trigger, reference,
                f"price {price:.2f} fell {1 - price / reference:.1%} from {reference:.2f}; locking in profit",
                max(floor, round(bid, 2)))
    return ("sell_at_cost", trigger, reference,
            f"price {price:.2f} dropped to or below cost {avg_cost:.2f}; resting sell at cost (break-even)", floor)


class PriceTracker:
    """Persists per-day OHLC of observed prices and peaks; appends a price log."""

    def __init__(self, state_file: str | Path = "data/price_tracker.json",
                 log_file: str | Path = "data/price_log.jsonl"):
        self.state_file = _abs(state_file)
        self.log_file = _abs(log_file)
        self.state = {"date": None, "days": {}, "peaks": {}, "triggered": {}}
        if self.state_file.exists():
            self.state.update(json.loads(self.state_file.read_text()))

    def observe(self, symbol: str, price: float, avg_cost: float, qty: float, today: str) -> dict:
        if self.state["date"] != today:
            self.state["date"] = today
            self.state["days"] = {}
            self.state["triggered"] = {}
        d = self.state["days"].setdefault(symbol, {"open": price, "high": price, "low": price, "last": price})
        d["high"], d["low"], d["last"] = max(d["high"], price), min(d["low"], price), price
        if price > avg_cost:
            self.state["peaks"][symbol] = max(self.state["peaks"].get(symbol, price), price)
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        with self.log_file.open("a") as fh:
            fh.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), "date": today, "symbol": symbol,
                                 "price": round(price, 4), "avg_cost": round(avg_cost, 4), "qty": qty}) + "\n")
        return d

    def forget(self, symbol: str) -> None:
        self.state["peaks"].pop(symbol, None)

    def save(self) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps(self.state, indent=2))

    def log_rows(self) -> list[dict]:
        if not self.log_file.exists():
            return []
        return [json.loads(l) for l in self.log_file.read_text().splitlines() if l.strip()]


def _abs(path: str | Path) -> Path:
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


def run_check(ctx: SkillContext, cfg: ProfitProtectConfig, tracker: PriceTracker,
              execute: bool = True, today: str | None = None) -> list[Decision]:
    """One pass over all holdings. ``execute=False`` only reports what would happen."""
    today = today or date.today().isoformat()
    broker = ctx.broker
    if hasattr(broker, "process_open_orders"):
        broker.process_open_orders()
    positions = [p for p in broker.get_positions()
                 if p.qty > 0 and (p.asset_class == AssetClass.STOCK
                                   or (cfg.include_etfs and p.asset_class == AssetClass.ETF))]
    held = {p.symbol for p in broker.get_positions()}
    for sym in list(tracker.state["peaks"]):
        if sym not in held:
            tracker.forget(sym)

    wanted = {s.upper() for s in cfg.symbols}
    excluded = {s.upper() for s in cfg.exclude_symbols}
    open_sells = {o.symbol for o in broker.list_orders("open") if o.side == Side.SELL}
    decisions = []
    for pos in positions:
        q = broker.get_quote(pos.symbol)
        price = q.last or q.mid
        day = tracker.observe(pos.symbol, price, pos.avg_entry_price, pos.qty, today)
        if (wanted and pos.symbol not in wanted) or pos.symbol in excluded or not cfg.enabled:
            decisions.append(Decision(pos.symbol, "skip", price, pos.avg_entry_price, pos.qty, None, None,
                                      "excluded by profit_protect config"))
            continue
        peak = tracker.state["peaks"].get(pos.symbol, price)
        action, trigger, ref, reason, limit = evaluate(price, q.bid, pos.avg_entry_price, day["high"], peak, cfg)
        d = Decision(pos.symbol, action, price, pos.avg_entry_price, pos.qty, trigger, ref, reason, limit)
        if action in ("sell_now", "sell_at_cost"):
            if pos.symbol in open_sells or tracker.state["triggered"].get(pos.symbol):
                d.result = "already has a working sell order"
            elif not execute:
                d.result = "dry_run"
            else:
                d.result = _sell(ctx, cfg, pos, d)
                tracker.state["triggered"][pos.symbol] = d.result
        decisions.append(d)
    tracker.save()
    return decisions


def _sell(ctx: SkillContext, cfg: ProfitProtectConfig, pos, d: Decision) -> str:
    live = ctx.settings.is_live
    auto = cfg.auto_sell and (not live or cfg.auto_sell_live)
    order = Order(pos.symbol, pos.qty, Side.SELL, pos.asset_class, OrderType.LIMIT,
                  TimeInForce.GTC if d.action == "sell_at_cost" else TimeInForce.DAY,
                  limit_price=d.limit_price, reason=f"profit_protect: {d.reason}")
    ctx.journal.record("profit_protect_trigger", decision=d.to_dict(), auto=auto, live=live)
    run_ctx = dataclasses.replace(ctx, approver=auto_approve) if auto else ctx
    out = run_ctx.execute_order(order)
    return out["status"]


def market_open(broker) -> bool:
    check = getattr(broker, "is_market_open", None)
    return True if check is None else bool(check())


__all__ = ["ProfitProtectConfig", "PriceTracker", "Decision", "evaluate", "run_check", "market_open"]
