"""Realized / unrealized P&L from broker fills.

* ``PnlLedger`` keeps a local copy of every fill (data/fills.jsonl), synced from the broker
  and de-duplicated by fill id.
* ``realized_trades`` matches fills FIFO per symbol (longs and shorts), so every closed
  quantity becomes a ``ClosedTrade`` with its own P&L, net of commissions.
* ``EquityHistory`` appends account snapshots for the equity curve.
"""

from __future__ import annotations

import json
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .brokers.base import Broker
from .config import PROJECT_ROOT
from .models import Fill, Side


def _abs(path: str | Path) -> Path:
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


@dataclass
class ClosedTrade:
    symbol: str
    qty: float
    direction: str          # "long" | "short"
    open_price: float
    close_price: float
    opened_at: datetime
    closed_at: datetime
    pnl: float
    asset_class: str

    def to_dict(self) -> dict:
        return {"symbol": self.symbol, "qty": self.qty, "direction": self.direction,
                "open_price": self.open_price, "close_price": self.close_price,
                "opened_at": self.opened_at.isoformat(), "closed_at": self.closed_at.isoformat(),
                "pnl": round(self.pnl, 2), "asset_class": self.asset_class}


class PnlLedger:
    def __init__(self, path: str | Path = "data/fills.jsonl"):
        self.path = _abs(path)

    def fills(self) -> list[Fill]:
        if not self.path.exists():
            return []
        rows = [Fill.from_dict(json.loads(l)) for l in self.path.read_text().splitlines() if l.strip()]
        return sorted(rows, key=lambda f: f.timestamp)

    def sync(self, broker: Broker) -> int:
        """Pull fills from the broker; returns how many were new."""
        known = {f.id for f in self.fills()}
        new = [f for f in broker.get_fills() if f.id not in known]
        if new:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as fh:
                for f in new:
                    fh.write(json.dumps(f.to_dict()) + "\n")
        return len(new)


def realized_trades(fills: list[Fill]) -> list[ClosedTrade]:
    """FIFO lot matching. Each lot is [signed_qty, price, commission_per_unit, ts]."""
    lots: dict[str, deque] = defaultdict(deque)
    closed: list[ClosedTrade] = []
    for f in sorted(fills, key=lambda x: x.timestamp):
        signed = f.qty if f.side == Side.BUY else -f.qty
        fee_unit = f.commission / f.qty if f.qty else 0.0
        book = lots[f.symbol]
        remaining = signed
        while remaining and book and (book[0][0] > 0) != (remaining > 0):
            lot = book[0]
            q = min(abs(remaining), abs(lot[0]))
            long_lot = lot[0] > 0
            gross = (f.price - lot[1]) * q if long_lot else (lot[1] - f.price) * q
            pnl = gross * f.multiplier - (lot[2] + fee_unit) * q
            closed.append(ClosedTrade(f.symbol, q, "long" if long_lot else "short", lot[1], f.price,
                                      lot[3], f.timestamp, pnl, f.asset_class.value))
            lot[0] += q if not long_lot else -q
            remaining += q if remaining < 0 else -q
            if abs(lot[0]) < 1e-9:
                book.popleft()
        if abs(remaining) > 1e-9:
            book.append([remaining, f.price, fee_unit, f.timestamp])
    return closed


def summarize(trades: list[ClosedTrade]) -> dict:
    profit = sum(t.pnl for t in trades if t.pnl > 0)
    loss = sum(t.pnl for t in trades if t.pnl < 0)
    wins = sum(1 for t in trades if t.pnl > 0)
    losses = sum(1 for t in trades if t.pnl < 0)
    by_symbol: dict[str, float] = defaultdict(float)
    by_day: dict[str, float] = defaultdict(float)
    for t in trades:
        by_symbol[t.symbol] += t.pnl
        by_day[t.closed_at.date().isoformat()] += t.pnl
    cumulative, running = [], 0.0
    for day in sorted(by_day):
        running += by_day[day]
        cumulative.append({"date": day, "pnl": round(by_day[day], 2), "cumulative": round(running, 2)})
    return {
        "realized_net": round(profit + loss, 2),
        "realized_profit": round(profit, 2),
        "realized_loss": round(loss, 2),
        "closed_trades": len(trades),
        "wins": wins,
        "losses": losses,
        "win_rate": round(wins / (wins + losses), 4) if wins + losses else None,
        "by_symbol": {k: round(v, 2) for k, v in sorted(by_symbol.items(), key=lambda kv: kv[1])},
        "by_day": cumulative,
    }


class EquityHistory:
    def __init__(self, path: str | Path = "data/equity_history.jsonl"):
        self.path = _abs(path)

    def snapshot(self, broker: Broker, ts: datetime | None = None) -> dict:
        acct = broker.get_account()
        positions = broker.get_positions()
        row = {"ts": (ts or datetime.now(timezone.utc)).isoformat(), "equity": round(acct.equity, 2),
               "cash": round(acct.cash, 2),
               "unrealized": round(sum(p.unrealized_pl for p in positions), 2)}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(json.dumps(row) + "\n")
        return row

    def rows(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(l) for l in self.path.read_text().splitlines() if l.strip()]


def pnl_report(broker: Broker, ledger: PnlLedger) -> dict:
    ledger.sync(broker)
    trades = realized_trades(ledger.fills())
    out = summarize(trades)
    positions = broker.get_positions()
    out["unrealized"] = round(sum(p.unrealized_pl for p in positions), 2)
    out["open_positions"] = [p.to_dict() for p in positions]
    out["recent_closed"] = [t.to_dict() for t in trades[-20:]]
    return out
