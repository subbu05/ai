import pytest

from trading_agent.brokers import PaperBroker
from trading_agent.config import RiskLimits, Settings
from trading_agent.journal import TradeJournal
from trading_agent.risk import RiskManager
from trading_agent.skills import SkillContext, auto_approve, default_registry


@pytest.fixture
def broker():
    return PaperBroker(starting_cash=100_000)


@pytest.fixture
def limits(tmp_path):
    return RiskLimits(kill_switch_file=str(tmp_path / "kill"))


@pytest.fixture
def ctx(broker, limits, tmp_path):
    settings = Settings(risk=limits, journal_file=str(tmp_path / "journal.jsonl"))
    return SkillContext(broker, RiskManager(broker, limits), TradeJournal(settings.journal_file),
                        settings, auto_approve)


@pytest.fixture
def registry():
    return default_registry()
