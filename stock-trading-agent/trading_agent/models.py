"""Core domain models shared by brokers, skills, risk and the agent."""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any


class AssetClass(str, Enum):
    STOCK = "stock"
    ETF = "etf"
    OPTION = "option"


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(str, Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


class TimeInForce(str, Enum):
    DAY = "day"
    GTC = "gtc"


class OrderStatus(str, Enum):
    NEW = "new"
    FILLED = "filled"
    PARTIALLY_FILLED = "partially_filled"
    CANCELED = "canceled"
    REJECTED = "rejected"
    PENDING = "pending"


class OptionRight(str, Enum):
    CALL = "call"
    PUT = "put"


class PositionIntent(str, Enum):
    """Whether an option order opens or closes exposure (matters for risk)."""

    OPEN = "open"
    CLOSE = "close"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class OptionContract:
    underlying: str
    expiration: date
    strike: float
    right: OptionRight
    multiplier: int = 100

    @property
    def occ_symbol(self) -> str:
        """OCC-style symbol, e.g. AAPL250117C00150000."""
        exp = self.expiration.strftime("%y%m%d")
        strike = f"{int(round(self.strike * 1000)):08d}"
        return f"{self.underlying.upper()}{exp}{self.right.value[0].upper()}{strike}"

    @classmethod
    def from_occ(cls, symbol: str) -> "OptionContract":
        symbol = symbol.strip().upper()
        if len(symbol) < 16:
            raise ValueError(f"Not an OCC option symbol: {symbol!r}")
        root, exp, cp, strike = symbol[:-15], symbol[-15:-9], symbol[-9], symbol[-8:]
        if cp not in ("C", "P"):
            raise ValueError(f"Not an OCC option symbol: {symbol!r}")
        return cls(
            underlying=root,
            expiration=datetime.strptime(exp, "%y%m%d").date(),
            strike=int(strike) / 1000,
            right=OptionRight.CALL if cp == "C" else OptionRight.PUT,
        )


@dataclass
class Quote:
    symbol: str
    bid: float
    ask: float
    last: float
    timestamp: datetime = field(default_factory=_utcnow)

    @property
    def mid(self) -> float:
        if self.bid > 0 and self.ask > 0:
            return round((self.bid + self.ask) / 2, 4)
        return self.last


@dataclass
class Order:
    symbol: str
    qty: float
    side: Side
    asset_class: AssetClass
    order_type: OrderType = OrderType.MARKET
    time_in_force: TimeInForce = TimeInForce.DAY
    limit_price: float | None = None
    stop_price: float | None = None
    intent: PositionIntent = PositionIntent.OPEN
    client_order_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    # Filled in by the broker
    id: str | None = None
    status: OrderStatus = OrderStatus.PENDING
    filled_qty: float = 0.0
    filled_avg_price: float | None = None
    submitted_at: datetime | None = None
    reason: str | None = None  # rationale supplied by the skill / agent

    @property
    def multiplier(self) -> int:
        return 100 if self.asset_class == AssetClass.OPTION else 1

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, Enum):
                d[k] = v.value
            elif isinstance(v, datetime):
                d[k] = v.isoformat()
        return d


@dataclass
class Position:
    symbol: str
    qty: float
    avg_entry_price: float
    asset_class: AssetClass
    current_price: float = 0.0

    @property
    def multiplier(self) -> int:
        return 100 if self.asset_class == AssetClass.OPTION else 1

    @property
    def market_value(self) -> float:
        return self.qty * self.current_price * self.multiplier

    @property
    def unrealized_pl(self) -> float:
        return (self.current_price - self.avg_entry_price) * self.qty * self.multiplier

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "qty": self.qty,
            "avg_entry_price": round(self.avg_entry_price, 4),
            "current_price": round(self.current_price, 4),
            "market_value": round(self.market_value, 2),
            "unrealized_pl": round(self.unrealized_pl, 2),
            "asset_class": self.asset_class.value,
        }


@dataclass
class Account:
    cash: float
    equity: float
    buying_power: float
    day_start_equity: float
    options_level: int = 2  # 0 none, 1 covered, 2 long + cash-secured, 3 spreads

    @property
    def day_pl(self) -> float:
        return self.equity - self.day_start_equity

    def to_dict(self) -> dict[str, Any]:
        return {
            "cash": round(self.cash, 2),
            "equity": round(self.equity, 2),
            "buying_power": round(self.buying_power, 2),
            "day_pl": round(self.day_pl, 2),
            "options_level": self.options_level,
        }
