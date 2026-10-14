"""Broker interface. Every broker adapter implements this contract."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date, datetime

from ..models import Account, Fill, OptionContract, Order, Position, Quote


class BrokerError(RuntimeError):
    pass


class Broker(ABC):
    name: str = "base"

    @abstractmethod
    def get_account(self) -> Account: ...

    @abstractmethod
    def get_positions(self) -> list[Position]: ...

    def get_position(self, symbol: str) -> Position | None:
        symbol = symbol.upper()
        return next((p for p in self.get_positions() if p.symbol == symbol), None)

    @abstractmethod
    def get_quote(self, symbol: str) -> Quote: ...

    @abstractmethod
    def get_option_chain(
        self, underlying: str, expiration: date | None = None
    ) -> list[tuple[OptionContract, Quote]]: ...

    @abstractmethod
    def submit_order(self, order: Order) -> Order: ...

    @abstractmethod
    def cancel_order(self, order_id: str) -> None: ...

    @abstractmethod
    def list_orders(self, status: str = "open") -> list[Order]: ...

    def get_fills(self, since: datetime | None = None) -> list[Fill]:
        """Executions, oldest first. Used for realized P&L."""
        return []

    def get_history(self, symbol: str, days: int = 60) -> list[float]:
        """Daily closes, oldest first. Optional; used by strategy skills."""
        raise BrokerError(f"{self.name} does not provide price history")
