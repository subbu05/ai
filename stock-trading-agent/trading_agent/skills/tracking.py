"""Price tracking, profit protection and P&L skills."""

from __future__ import annotations

from .base import Skill, SkillContext, SkillRegistry, schema


def tracker(ctx: SkillContext):
    from ..monitor import PriceTracker

    d = ctx.settings.data_dir
    return PriceTracker(d / "price_tracker.json", d / "price_log.jsonl")


def track_prices(ctx: SkillContext, dry_run: bool = True) -> dict:
    from ..monitor import ProfitProtectConfig, run_check

    cfg = ProfitProtectConfig.load()
    from ..watchlist import Watchlist

    wl = Watchlist(ctx.settings.data_dir / "watchlist.json")
    decisions = run_check(ctx, cfg, tracker(ctx), execute=not dry_run, watchlist=wl)
    return {"dry_run": dry_run, "drop_pct": cfg.drop_pct, "reference": cfg.reference,
            "decisions": [d.to_dict() for d in decisions]}


def get_price_tracking(ctx: SkillContext) -> dict:
    t = tracker(ctx)
    return {"date": t.state["date"], "today": t.state["days"], "peaks_since_profit": t.state["peaks"],
            "triggered_today": t.state["triggered"]}


def get_pnl_summary(ctx: SkillContext) -> dict:
    from ..pnl import PnlLedger, pnl_report

    report = pnl_report(ctx.broker, PnlLedger(ctx.settings.data_dir / "fills.jsonl"))
    report.pop("recent_closed", None)
    return report


def watchlist_list(ctx: SkillContext, labels: list[str] | None = None) -> dict:
    from ..watchlist import Watchlist

    wl = Watchlist(ctx.settings.data_dir / "watchlist.json")
    items = wl.filter(labels)
    return {"items": [{"symbol": i.symbol, "labels": i.labels, "monitor": i.monitor} for i in items],
            "groups": wl.grouped(items), "labels": wl.labels}


def watchlist_add(ctx: SkillContext, symbol: str, labels: list[str] | None = None, monitor: bool = True) -> dict:
    from ..watchlist import Watchlist

    item = Watchlist(ctx.settings.data_dir / "watchlist.json").add(symbol, labels or [], monitor)
    return {"symbol": item.symbol, "labels": item.labels, "monitor": item.monitor}


def watchlist_remove(ctx: SkillContext, symbol: str) -> dict:
    from ..watchlist import Watchlist

    return {"removed": Watchlist(ctx.settings.data_dir / "watchlist.json").remove(symbol)}


def buy_label_basket(ctx: SkillContext, label: str, amount: float, order_type: str = "market",
                     discount_pct: float = 0.05, time_in_force: str = "day", skip_held: bool = False,
                     dry_run: bool = True) -> dict:
    from ..basket import BasketError, plan_basket, run_basket
    from ..skills import default_registry
    from ..watchlist import Watchlist

    wl = Watchlist(ctx.settings.data_dir / "watchlist.json")
    try:
        plan = plan_basket(ctx, wl, label, amount, order_type, discount_pct, time_in_force, skip_held)
        return run_basket(ctx, default_registry(), plan, dry_run=dry_run).to_dict()
    except (BasketError, ValueError) as e:
        return {"status": "invalid", "error": str(e)}


def register(reg: SkillRegistry) -> None:
    reg.register(Skill(
        "track_prices",
        "Record current prices of stock/ETF holdings and apply the profit-protection rule: if a "
        "position that has been in profit drops drop_pct (1-10%, see config) from today's high, sell "
        "all of it while still in profit, never below cost. dry_run defaults to TRUE (report only).",
        schema({"dry_run": {"type": "boolean", "default": True}}),
        track_prices, places_orders=True, tags=["strategy", "monitor"]))
    reg.register(Skill(
        "watchlist_list", "Watchlist tickers with their labels and monitor flag, grouped by label. "
        "Optionally filter by labels (any match).",
        schema({"labels": {"type": "array", "items": {"type": "string"}}}), watchlist_list, tags=["monitor"]))
    reg.register(Skill(
        "watchlist_add", "Add a ticker to the watchlist with optional labels; monitor=true lets profit "
        "protection manage it when held.",
        schema({"symbol": {"type": "string"}, "labels": {"type": "array", "items": {"type": "string"}},
                "monitor": {"type": "boolean", "default": True}}, ["symbol"]), watchlist_add, tags=["monitor"]))
    reg.register(Skill(
        "watchlist_remove", "Remove a ticker from the watchlist (does not sell anything).",
        schema({"symbol": {"type": "string"}}, ["symbol"]), watchlist_remove, tags=["monitor"]))
    reg.register(Skill(
        "buy_label_basket",
        "Buy every watchlist ticker that has a given label, splitting `amount` dollars equally "
        "(whole shares). order_type 'market' buys at the market; 'limit' places limit orders "
        "discount_pct below the current price (default 0.05 = 5%), which fill only if the price "
        "drops. Each order is risk-checked. dry_run defaults to TRUE: show the plan, then re-run "
        "with dry_run=false after the user confirms.",
        schema({"label": {"type": "string"}, "amount": {"type": "number", "exclusiveMinimum": 0},
                "order_type": {"type": "string", "enum": ["market", "limit"], "default": "market"},
                "discount_pct": {"type": "number", "exclusiveMinimum": 0, "maximum": 0.5, "default": 0.05},
                "time_in_force": {"type": "string", "enum": ["day", "gtc"], "default": "day"},
                "skip_held": {"type": "boolean", "default": False},
                "dry_run": {"type": "boolean", "default": True}}, ["label", "amount"]),
        buy_label_basket, places_orders=True, tags=["trade", "strategy", "watchlist"]))
    reg.register(Skill(
        "get_price_tracking", "Today's tracked open/high/low/last per holding and peaks since in profit.",
        schema({}), get_price_tracking, tags=["monitor"]))
    reg.register(Skill(
        "get_pnl_summary",
        "Realized profit, realized loss, net realized P&L, win rate, P&L by symbol and by day, "
        "plus unrealized P&L on open positions.",
        schema({}), get_pnl_summary, tags=["portfolio", "pnl"]))
