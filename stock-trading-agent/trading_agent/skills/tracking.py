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
    decisions = run_check(ctx, cfg, tracker(ctx), execute=not dry_run)
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


def register(reg: SkillRegistry) -> None:
    reg.register(Skill(
        "track_prices",
        "Record current prices of stock/ETF holdings and apply the profit-protection rule: if a "
        "position that has been in profit drops drop_pct (1-10%, see config) from today's high, sell "
        "all of it while still in profit, never below cost. dry_run defaults to TRUE (report only).",
        schema({"dry_run": {"type": "boolean", "default": True}}),
        track_prices, places_orders=True, tags=["strategy", "monitor"]))
    reg.register(Skill(
        "get_price_tracking", "Today's tracked open/high/low/last per holding and peaks since in profit.",
        schema({}), get_price_tracking, tags=["monitor"]))
    reg.register(Skill(
        "get_pnl_summary",
        "Realized profit, realized loss, net realized P&L, win rate, P&L by symbol and by day, "
        "plus unrealized P&L on open positions.",
        schema({}), get_pnl_summary, tags=["portfolio", "pnl"]))
