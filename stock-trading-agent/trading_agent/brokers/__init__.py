from pathlib import Path

from ..config import PROJECT_ROOT, Settings
from .base import Broker, BrokerError
from .paper import PaperBroker, SimulatedMarket


def create_broker(settings: Settings) -> Broker:
    if settings.broker == "paper":
        from ..market_data import SimulatedProvider, build_provider

        state = Path(settings.paper_state_file)
        broker = PaperBroker(settings.paper_starting_cash, state if state.is_absolute() else PROJECT_ROOT / state)
        provider = build_provider(settings.market_data, broker.market)
        if not isinstance(provider, SimulatedProvider):
            broker.data = provider  # paper trading on live prices
        return broker
    if settings.broker == "alpaca":
        from .alpaca import AlpacaBroker

        return AlpacaBroker(settings.alpaca_key_id, settings.alpaca_secret_key, live=settings.is_live)
    raise ValueError(f"Unknown broker {settings.broker!r}")


__all__ = ["Broker", "BrokerError", "PaperBroker", "SimulatedMarket", "create_broker"]
