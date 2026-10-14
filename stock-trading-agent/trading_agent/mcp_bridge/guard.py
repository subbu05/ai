"""Classify broker MCP tools and gate the ones that can move money.

Broker MCP servers have their own order schemas, so the full ``RiskManager``
(which needs our Order model) can't be applied to them. Instead every
account-changing call goes through this guard:

* kill switch
* symbol allow/block lists (from config/risk.toml)
* best-effort notional cap (qty x price, x100 for options) against max_order_notional
* explicit human approval (always required for live servers)
* journal entry for the proposal and the outcome
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .config import McpServerConfig

READ = "read"
TRADE = "trade"
WRITE = "write"   # changes state but doesn't trade (watchlists, alerts, ...)

_READ_PREFIX = re.compile(r"^(get|list|search|preview|review|describe|fetch|lookup|query|show|check)_?")
_TRADE_WORDS = re.compile(
    r"(^|_)(place|replace|modify|cancel|close|liquidate|exercise|submit|order|buy|sell|trade|roll)(_|$)")

_QTY_KEYS = ("qty", "quantity", "contracts", "shares")
_PRICE_KEYS = ("limit_price", "price", "stop_price", "notional_price")
_NOTIONAL_KEYS = ("notional", "dollar_amount", "amount")
_SYMBOL_KEYS = ("symbol", "symbols", "underlying", "underlying_symbol", "ticker", "option_symbol",
                "symbol_or_asset_id")


def classify(tool_name: str, server: McpServerConfig, annotations: Any = None) -> str:
    for pattern in server.trade_tools:
        if re.search(pattern, tool_name):
            return TRADE
    for pattern in server.read_tools:
        if re.search(pattern, tool_name):
            return READ
    if _READ_PREFIX.match(tool_name):
        return READ
    if _TRADE_WORDS.search(tool_name):
        return TRADE
    if annotations is not None and getattr(annotations, "read_only_hint", None) is True:
        return READ
    return WRITE


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def extract_symbols(args: dict) -> set[str]:
    found: set[str] = set()

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in _SYMBOL_KEYS:
                    vals = v if isinstance(v, list) else str(v).split(",") if isinstance(v, str) else []
                    for s in vals:
                        s = str(s).strip().upper()
                        if s:
                            # OCC option symbol -> underlying
                            m = re.match(r"^([A-Z.]{1,6})\d{6}[CP]\d{8}$", s)
                            found.add(m.group(1) if m else s)
                else:
                    walk(v)
        elif isinstance(obj, list):
            for x in obj:
                walk(x)

    walk(args)
    return found


def estimate_notional(tool_name: str, args: dict) -> float | None:
    for k in _NOTIONAL_KEYS:
        if (n := _num(args.get(k))) is not None:
            return n
    qty = next((q for k in _QTY_KEYS if (q := _num(args.get(k))) is not None), None)
    price = next((p for k in _PRICE_KEYS if (p := _num(args.get(k))) is not None), None)
    if qty is None or price is None:
        return None
    is_option = "option" in tool_name or bool(args.get("legs")) or bool(
        re.match(r"^[A-Z.]{1,6}\d{6}[CP]\d{8}$", str(args.get("symbol", "")).upper()))
    return qty * price * (100 if is_option else 1)


@dataclass
class GuardDecision:
    allowed: bool
    reasons: list[str]
    warnings: list[str]
    est_notional: float | None

    def to_dict(self) -> dict:
        return {"allowed": self.allowed, "reasons": self.reasons, "warnings": self.warnings,
                "est_notional": self.est_notional}


def check(tool_name: str, args: dict, kind: str, server: McpServerConfig, risk) -> GuardDecision:
    """``risk`` is the RiskManager (used for limits and the kill switch)."""
    reasons: list[str] = []
    warnings: list[str] = []
    if kind == READ:
        return GuardDecision(True, [], [], None)
    if server.read_only:
        return GuardDecision(False, [f"{server.name} is configured read_only"], [], None)
    if risk.kill_switch_active():
        return GuardDecision(False, ["kill switch engaged"], [], None)

    notional = estimate_notional(tool_name, args) if kind == TRADE else None
    if kind == TRADE:
        L = risk.limits
        is_cancel = tool_name.startswith("cancel")
        symbols = extract_symbols(args)
        if not is_cancel:
            allowed = {s.upper() for s in L.allowed_symbols}
            blocked = {s.upper() for s in L.blocked_symbols}
            for s in symbols:
                if allowed and s not in allowed:
                    reasons.append(f"{s} not in allowed_symbols")
                if s in blocked:
                    reasons.append(f"{s} is in blocked_symbols")
            if notional is None:
                warnings.append("could not estimate order value from the arguments; "
                                "max_order_notional NOT enforced - check the size yourself")
            elif notional > L.max_order_notional:
                reasons.append(f"estimated order value {notional:,.2f} > max_order_notional "
                               f"{L.max_order_notional:,.2f}")
        if "_all_" in f"_{tool_name}_" or tool_name.endswith("_all"):
            warnings.append("this action applies to ALL orders/positions in the account")
        warnings.append("broker-side MCP order: position caps, options coverage and daily-loss "
                        "checks are NOT applied here; rely on the broker's own controls too")
    if server.live:
        warnings.append(f"{server.name} is a LIVE account (real money)")
    return GuardDecision(not reasons, reasons, warnings, notional)
