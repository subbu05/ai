#!/usr/bin/env python3
"""Simulate N trading days of the price monitor on a throwaway paper account, then build
the P&L dashboard. Everything goes to a separate folder; your real data/ isn't touched.

    python scripts/demo_monitor.py --days 30 --out reports/demo_dashboard.html
"""

from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from trading_agent.brokers import PaperBroker  # noqa: E402
from trading_agent.brokers.paper import SimulatedMarket  # noqa: E402
from trading_agent.config import RiskLimits, Settings  # noqa: E402
from trading_agent.dashboard import write_dashboard  # noqa: E402
from trading_agent.journal import TradeJournal  # noqa: E402
from trading_agent.models import AssetClass, Order, Side  # noqa: E402
from trading_agent.monitor import PriceTracker, ProfitProtectConfig, run_check  # noqa: E402
from trading_agent.pnl import EquityHistory, PnlLedger  # noqa: E402
from trading_agent.risk import RiskManager  # noqa: E402
from trading_agent.skills import SkillContext, auto_approve  # noqa: E402

BASKET = [("NVDA", 60, AssetClass.STOCK), ("AAPL", 40, AssetClass.STOCK), ("JPM", 40, AssetClass.STOCK),
          ("MSFT", 20, AssetClass.STOCK), ("QQQ", 15, AssetClass.ETF)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--checks-per-day", type=int, default=26, help="26 = every 15 min of a session")
    ap.add_argument("--drop-pct", type=float, default=0.03)
    ap.add_argument("--vol", type=float, default=0.45, help="simulated annualized volatility")
    ap.add_argument("--dir", default=str(ROOT / "reports" / "demo_data"))
    ap.add_argument("--out", default=str(ROOT / "reports" / "demo_dashboard.html"))
    args = ap.parse_args()

    data = Path(args.dir)
    data.mkdir(parents=True, exist_ok=True)
    for f in data.glob("*"):
        f.unlink()

    broker = PaperBroker(100_000, data / "paper_account.json", market=SimulatedMarket(vol=args.vol))
    limits = RiskLimits(kill_switch_file=str(data / "no_kill_switch"))
    settings = Settings(risk=limits, journal_file=str(data / "trade_journal.jsonl"))
    ctx = SkillContext(broker, RiskManager(broker, limits), TradeJournal(settings.journal_file),
                       settings, auto_approve)
    cfg = ProfitProtectConfig(drop_pct=args.drop_pct, respect_market_hours=False).validate()
    tracker = PriceTracker(data / "price_tracker.json", data / "price_log.jsonl")
    equity = EquityHistory(data / "equity_history.jsonl")
    ledger = PnlLedger(data / "fills.jsonl")

    day = date.today() - timedelta(days=int(args.days * 1.45))
    traded = 0
    while traded < args.days:
        day += timedelta(days=1)
        if day.weekday() >= 5:
            continue
        traded += 1
        for i in range(args.checks_per_day):
            now = datetime.combine(day, time(13, 30), timezone.utc) + timedelta(minutes=15 * i)
            broker.clock = lambda now=now: now
            if i == 0:  # re-buy anything from the basket we no longer hold
                for sym, qty, ac in BASKET:
                    if broker.get_position(sym) is None:
                        ctx.execute_order(Order(sym, qty, Side.BUY, ac, reason="demo entry"))
            broker.tick([s for s, _, _ in BASKET], minutes=15)
            run_check(ctx, cfg, tracker, today=day.isoformat())
        equity.snapshot(broker, ts=datetime.combine(day, time(20, 0), timezone.utc))
        ledger.sync(broker)

    out = write_dashboard(broker, data, Path(args.out), "paper (simulated demo)")
    print(f"Simulated {args.days} trading days. Dashboard: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
