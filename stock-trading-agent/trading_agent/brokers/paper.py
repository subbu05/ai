"""Local paper-trading broker with simulated market data.

Prices come from a deterministic, seeded random walk per symbol so runs are
reproducible and the whole system works offline. Plug in a real
``QuoteProvider`` (see ``brokers/alpaca.py``) to paper-trade on live prices.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from ..models import (
    Account,
    AssetClass,
    OptionContract,
    OptionRight,
    Order,
    OrderStatus,
    OrderType,
    Position,
    Quote,
    Side,
)
from ..options_math import black_scholes, years_to_expiry
from .base import Broker, BrokerError

QuoteProvider = Callable[[str], Quote]

# Rough anchor prices so simulated quotes look plausible.
_ANCHORS = {
    "SPY": 560.0, "QQQ": 480.0, "IWM": 210.0, "VTI": 275.0, "VOO": 515.0,
    "AGG": 98.0, "TLT": 92.0, "GLD": 225.0, "XLK": 220.0, "XLE": 90.0,
    "AAPL": 225.0, "MSFT": 420.0, "NVDA": 120.0, "AMZN": 185.0, "GOOGL": 165.0,
    "META": 520.0, "TSLA": 240.0, "JPM": 210.0,
}


def _seed(symbol: str) -> int:
    return int(hashlib.sha256(symbol.encode()).hexdigest()[:8], 16)


class SimulatedMarket:
    """Deterministic random-walk market. ``tick()`` advances prices."""

    def __init__(self, vol: float = 0.25, spread_bps: float = 5.0):
        self.vol = vol
        self.spread_bps = spread_bps
        self._prices: dict[str, float] = {}
        self._rngs: dict[str, random.Random] = {}

    def _rng(self, symbol: str) -> random.Random:
        if symbol not in self._rngs:
            self._rngs[symbol] = random.Random(_seed(symbol))
        return self._rngs[symbol]

    def price(self, symbol: str) -> float:
        if symbol not in self._prices:
            base = _ANCHORS.get(symbol, 20 + (_seed(symbol) % 300))
            self._prices[symbol] = float(base)
        return self._prices[symbol]

    def tick(self, symbol: str, minutes: int = 1) -> float:
        dt = minutes / (252 * 390)
        shock = self._rng(symbol).gauss(0, 1) * self.vol * math.sqrt(dt)
        self._prices[symbol] = self.price(symbol) * math.exp(shock)
        return self._prices[symbol]

    def history(self, symbol: str, days: int) -> list[float]:
        rng = random.Random(_seed(symbol) ^ 0xBEEF)
        closes = [self.price(symbol)]
        for _ in range(days - 1):
            closes.append(closes[-1] / math.exp(rng.gauss(0.0003, self.vol / math.sqrt(252))))
        return list(reversed(closes))

    def quote(self, symbol: str) -> Quote:
        last = self.price(symbol)
        half = last * self.spread_bps / 20_000
        return Quote(symbol, round(last - half, 2), round(last + half, 2), round(last, 2))


class PaperBroker(Broker):
    name = "paper"

    def __init__(
        self,
        starting_cash: float = 100_000.0,
        state_file: str | Path | None = None,
        quote_provider: QuoteProvider | None = None,
        market: SimulatedMarket | None = None,
        commission_per_contract: float = 0.65,
        options_level: int = 2,
    ):
        self.market = market or SimulatedMarket()
        self._external_quotes = quote_provider
        self.commission_per_contract = commission_per_contract
        self.state_file = Path(state_file) if state_file else None
        self.cash = starting_cash
        self.options_level = options_level
        self.positions: dict[str, Position] = {}
        self.orders: dict[str, Order] = {}
        self.day_start_equity = starting_cash
        self._day = date.today().isoformat()
        self._load()

    # ------------------------------------------------------------------ data
    def get_quote(self, symbol: str) -> Quote:
        symbol = symbol.upper()
        if len(symbol) >= 16 and symbol[-9] in "CP" and symbol[-8:].isdigit():
            return self._option_quote(OptionContract.from_occ(symbol))
        if self._external_quotes:
            return self._external_quotes(symbol)
        return self.market.quote(symbol)

    def _option_quote(self, contract: OptionContract) -> Quote:
        spot = self.get_quote(contract.underlying).last
        g = black_scholes(spot, contract.strike, years_to_expiry(contract.expiration),
                          self.market.vol, contract.right)
        price = max(g.price, 0.01)
        half = max(0.01, price * 0.02)
        return Quote(contract.occ_symbol, round(max(price - half, 0.01), 2),
                     round(price + half, 2), round(price, 2))

    def get_option_chain(self, underlying: str, expiration: date | None = None):
        underlying = underlying.upper()
        spot = self.get_quote(underlying).last
        if expiration is None:
            # Next monthly-ish expiry: the Friday ~30 days out.
            d = date.today() + timedelta(days=30)
            expiration = d + timedelta(days=(4 - d.weekday()) % 7)
        step = 1 if spot < 50 else 5 if spot < 500 else 10
        atm = round(spot / step) * step
        chain = []
        for k in range(-5, 6):
            strike = atm + k * step
            if strike <= 0:
                continue
            for right in (OptionRight.CALL, OptionRight.PUT):
                c = OptionContract(underlying, expiration, float(strike), right)
                chain.append((c, self._option_quote(c)))
        return chain

    def get_history(self, symbol: str, days: int = 60) -> list[float]:
        return self.market.history(symbol.upper(), days)

    # --------------------------------------------------------------- account
    def _mark(self) -> None:
        for p in self.positions.values():
            p.current_price = self.get_quote(p.symbol).last

    def get_account(self) -> Account:
        self._roll_day()
        self._mark()
        equity = self.cash + sum(p.market_value for p in self.positions.values())
        # Cash secured against short puts reduces buying power.
        secured = sum(
            OptionContract.from_occ(p.symbol).strike * 100 * -p.qty
            for p in self.positions.values()
            if p.asset_class == AssetClass.OPTION and p.qty < 0
            and OptionContract.from_occ(p.symbol).right == OptionRight.PUT
        )
        return Account(self.cash, equity, max(self.cash - secured, 0.0),
                       self.day_start_equity, self.options_level)

    def get_positions(self) -> list[Position]:
        self._mark()
        return list(self.positions.values())

    # ---------------------------------------------------------------- orders
    def submit_order(self, order: Order) -> Order:
        order.symbol = order.symbol.upper()
        order.id = uuid.uuid4().hex
        order.submitted_at = datetime.now(timezone.utc)
        quote = self.get_quote(order.symbol)
        fill_price = quote.ask if order.side == Side.BUY else quote.bid

        if order.order_type in (OrderType.LIMIT, OrderType.STOP_LIMIT):
            if order.limit_price is None:
                raise BrokerError("limit_price required for limit orders")
            # Options often trade inside the spread: a limit at or through the mid fills there.
            touch = quote.mid if order.asset_class == AssetClass.OPTION else fill_price
            marketable = (touch <= order.limit_price if order.side == Side.BUY
                          else touch >= order.limit_price)
            if not marketable:
                order.status = OrderStatus.NEW  # rests until cancelled
                self.orders[order.id] = order
                self._save()
                return order
            fill_price = (min(fill_price, order.limit_price) if order.side == Side.BUY
                          else max(fill_price, order.limit_price))
        elif order.order_type == OrderType.STOP:
            order.status = OrderStatus.NEW
            self.orders[order.id] = order
            self._save()
            return order

        self._fill(order, fill_price)
        self.orders[order.id] = order
        self._save()
        return order

    def _fill(self, order: Order, price: float) -> None:
        mult = order.multiplier
        signed = order.qty if order.side == Side.BUY else -order.qty
        commission = self.commission_per_contract * order.qty if mult == 100 else 0.0
        cost = signed * price * mult + commission
        if order.side == Side.BUY and cost > self.cash:
            order.status = OrderStatus.REJECTED
            order.reason = f"insufficient cash: need {cost:.2f}, have {self.cash:.2f}"
            return

        self.cash -= cost
        pos = self.positions.get(order.symbol)
        if pos is None:
            self.positions[order.symbol] = Position(order.symbol, signed, price, order.asset_class, price)
        else:
            new_qty = pos.qty + signed
            if abs(new_qty) < 1e-9:
                del self.positions[order.symbol]
            else:
                if (pos.qty > 0) == (signed > 0):  # adding to position
                    pos.avg_entry_price = (pos.avg_entry_price * pos.qty + price * signed) / new_qty
                elif (pos.qty > 0) != (new_qty > 0):  # flipped through zero
                    pos.avg_entry_price = price
                pos.qty = new_qty
        order.status = OrderStatus.FILLED
        order.filled_qty = order.qty
        order.filled_avg_price = round(price, 4)

    def cancel_order(self, order_id: str) -> None:
        order = self.orders.get(order_id)
        if order is None:
            raise BrokerError(f"unknown order {order_id}")
        if order.status != OrderStatus.NEW:
            raise BrokerError(f"order {order_id} is {order.status.value}, cannot cancel")
        order.status = OrderStatus.CANCELED
        self._save()

    def list_orders(self, status: str = "open") -> list[Order]:
        orders = list(self.orders.values())
        if status == "open":
            orders = [o for o in orders if o.status == OrderStatus.NEW]
        return sorted(orders, key=lambda o: o.submitted_at or datetime.min.replace(tzinfo=timezone.utc))

    # ----------------------------------------------------------- persistence
    def _roll_day(self) -> None:
        today = date.today().isoformat()
        if today != self._day:
            self._day = today
            self._mark()
            self.day_start_equity = self.cash + sum(p.market_value for p in self.positions.values())

    def _save(self) -> None:
        if not self.state_file:
            return
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        state = {
            "cash": self.cash,
            "day": self._day,
            "day_start_equity": self.day_start_equity,
            "prices": self.market._prices,
            "positions": [
                {"symbol": p.symbol, "qty": p.qty, "avg_entry_price": p.avg_entry_price,
                 "asset_class": p.asset_class.value}
                for p in self.positions.values()
            ],
            "open_orders": [o.to_dict() for o in self.orders.values() if o.status == OrderStatus.NEW],
        }
        self.state_file.write_text(json.dumps(state, indent=2))

    def _load(self) -> None:
        if not self.state_file or not self.state_file.exists():
            return
        state = json.loads(self.state_file.read_text())
        self.cash = state["cash"]
        self._day = state.get("day", self._day)
        self.day_start_equity = state.get("day_start_equity", self.cash)
        self.market._prices.update(state.get("prices", {}))
        for p in state.get("positions", []):
            self.positions[p["symbol"]] = Position(
                p["symbol"], p["qty"], p["avg_entry_price"], AssetClass(p["asset_class"]))
