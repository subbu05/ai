"""Configuration loaded from environment variables and config/risk.toml."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RISK_FILE = PROJECT_ROOT / "config" / "risk.toml"


@dataclass
class RiskLimits:
    max_order_notional: float = 25_000.0
    max_position_pct: float = 0.20          # single stock position as % of equity
    max_etf_position_pct: float = 0.60      # single ETF position as % of equity (diversified funds)
    max_daily_loss_pct: float = 0.03        # halt new opening trades beyond this
    max_open_positions: int = 20
    max_option_premium_pct: float = 0.05    # premium per option order as % of equity
    max_total_option_pct: float = 0.15      # total long option exposure as % of equity
    min_option_dte: int = 7                 # refuse to open options expiring sooner
    allow_short_stock: bool = False
    allow_naked_options: bool = False       # only covered calls / cash-secured puts
    allowed_symbols: list[str] = field(default_factory=list)   # empty = all
    blocked_symbols: list[str] = field(default_factory=list)
    kill_switch_file: str = ".kill_switch"  # if this file exists, all trading halts

    @classmethod
    def load(cls, path: Path | None = None) -> "RiskLimits":
        path = path or Path(os.getenv("RISK_CONFIG", DEFAULT_RISK_FILE))
        if not path.exists():
            return cls()
        with path.open("rb") as fh:
            data = tomllib.load(fh).get("risk", {})
        known = {f.name for f in fields(cls)}
        unknown = set(data) - known
        if unknown:
            raise ValueError(f"Unknown risk settings in {path}: {sorted(unknown)}")
        return cls(**data)


@dataclass
class Settings:
    trading_mode: str = "paper"        # "paper" | "alpaca-paper" | "alpaca-live"
    broker: str = "paper"              # "paper" | "alpaca"
    alpaca_key_id: str = ""
    alpaca_secret_key: str = ""
    anthropic_model: str = "claude-opus-5-5"
    agent_effort: str = "high"
    require_approval: bool = True      # human confirms each order the agent proposes
    paper_starting_cash: float = 100_000.0
    paper_state_file: str = "data/paper_account.json"
    journal_file: str = "data/trade_journal.jsonl"
    risk: RiskLimits = field(default_factory=RiskLimits)

    @property
    def is_live(self) -> bool:
        return self.trading_mode == "alpaca-live"

    @classmethod
    def from_env(cls) -> "Settings":
        _load_dotenv(PROJECT_ROOT / ".env")
        mode = os.getenv("TRADING_MODE", "paper").lower()
        if mode not in ("paper", "alpaca-paper", "alpaca-live"):
            raise ValueError(f"Invalid TRADING_MODE {mode!r}")
        return cls(
            trading_mode=mode,
            broker="paper" if mode == "paper" else "alpaca",
            alpaca_key_id=os.getenv("ALPACA_API_KEY_ID", ""),
            alpaca_secret_key=os.getenv("ALPACA_API_SECRET_KEY", ""),
            anthropic_model=os.getenv("AGENT_MODEL", "claude-opus-5-5"),
            agent_effort=os.getenv("AGENT_EFFORT", "high"),
            require_approval=os.getenv("REQUIRE_APPROVAL", "true").lower() != "false",
            paper_starting_cash=float(os.getenv("PAPER_STARTING_CASH", "100000")),
            paper_state_file=os.getenv("PAPER_STATE_FILE", "data/paper_account.json"),
            journal_file=os.getenv("JOURNAL_FILE", "data/trade_journal.jsonl"),
            risk=RiskLimits.load(),
        )


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader so python-dotenv is not a hard dependency."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
