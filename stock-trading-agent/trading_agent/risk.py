"""Pre-trade risk engine. Every order passes through ``RiskManager.check``.

The engine is deliberately conservative: closing/reducing trades are always
allowed (so you can get out), opening trades must satisfy every limit.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .brokers.base import Broker
from .config import PROJECT_ROOT, RiskLimits
from .models import AssetClass, OptionContract, OptionRight, Order, PositionIntent, Side


@dataclass
class RiskDecision:
    approved: bool
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    est_notional: float = 0.0

    def to_dict(self) -> dict:
        return {"approved": self.approved, "reasons": self.reasons,
                "warnings": self.warnings, "est_notional": round(self.est_notional, 2)}


class RiskManager:
    def __init__(self, broker: Broker, limits: RiskLimits):
        self.broker = broker
        self.limits = limits

    def kill_switch_active(self) -> bool:
        path = Path(self.limits.kill_switch_file)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        return path.exists()

    def check(self, order: Order) -> RiskDecision:
        L = self.limits
        reasons: list[str] = []
        warnings: list[str] = []
        symbol = order.symbol.upper()
        underlying = (OptionContract.from_occ(symbol).underlying
                      if order.asset_class == AssetClass.OPTION else symbol)

        if self.kill_switch_active():
            return RiskDecision(False, [f"kill switch engaged ({L.kill_switch_file} exists)"])
        if order.qty <= 0:
            return RiskDecision(False, ["quantity must be positive"])
        if order.asset_class == AssetClass.OPTION and order.qty != int(order.qty):
            return RiskDecision(False, ["option quantity must be a whole number of contracts"])

        account = self.broker.get_account()
        position = self.broker.get_position(symbol)
        held = position.qty if position else 0.0
        quote = self.broker.get_quote(symbol)
        px = order.limit_price or (quote.ask if order.side == Side.BUY else quote.bid) or quote.last
        notional = px * order.qty * order.multiplier

        reducing = (order.side == Side.SELL and held > 0 and order.qty <= held) or \
                   (order.side == Side.BUY and held < 0 and order.qty <= -held)
        if reducing:
            # Always allow de-risking, even past loss limits.
            return RiskDecision(True, [], ["closing/reducing trade: limits bypassed"], notional)

        if order.asset_class == AssetClass.OPTION and order.intent == PositionIntent.CLOSE:
            reasons.append(f"no {symbol} position large enough to close {order.qty:g}")
            return RiskDecision(False, reasons, warnings, notional)

        # ---- symbol filters
        if L.allowed_symbols and underlying not in {s.upper() for s in L.allowed_symbols}:
            reasons.append(f"{underlying} not in allowed_symbols")
        if underlying in {s.upper() for s in L.blocked_symbols}:
            reasons.append(f"{underlying} is in blocked_symbols")

        # ---- account level
        if account.equity > 0 and -account.day_pl / account.day_start_equity >= L.max_daily_loss_pct:
            reasons.append(f"daily loss limit hit ({account.day_pl:,.2f}); only closing trades allowed")
        open_syms = {p.symbol for p in self.broker.get_positions()}
        if symbol not in open_syms and len(open_syms) >= L.max_open_positions:
            reasons.append(f"max_open_positions ({L.max_open_positions}) reached")

        # ---- order size
        if notional > L.max_order_notional and order.side == Side.BUY:
            reasons.append(f"order notional {notional:,.2f} > max_order_notional {L.max_order_notional:,.2f}")
        if order.side == Side.BUY and notional > account.buying_power:
            reasons.append(f"insufficient buying power ({account.buying_power:,.2f})")

        if order.asset_class == AssetClass.OPTION:
            self._check_option(order, account, notional, held, reasons, warnings)
        else:
            if order.side == Side.SELL and order.qty > held and not L.allow_short_stock:
                reasons.append(f"short selling disabled (holding {held:g}, selling {order.qty:g})")
            cap = L.max_etf_position_pct if order.asset_class == AssetClass.ETF else L.max_position_pct
            new_value = (held + order.qty) * px if order.side == Side.BUY else 0.0
            if account.equity > 0 and new_value / account.equity > cap:
                reasons.append(f"position would be {new_value / account.equity:.1%} of equity "
                               f"> {order.asset_class.value} position cap {cap:.0%}")

        if order.order_type.value == "market":
            spread = quote.ask - quote.bid
            if quote.mid > 0 and spread / quote.mid > 0.05:
                warnings.append(f"wide spread ({spread / quote.mid:.1%}); consider a limit order")

        return RiskDecision(not reasons, reasons, warnings, notional)

    def _check_option(self, order, account, notional, held, reasons, warnings):
        L = self.limits
        contract = OptionContract.from_occ(order.symbol)
        dte = (contract.expiration - date.today()).days
        if dte < L.min_option_dte:
            reasons.append(f"{dte} DTE < min_option_dte {L.min_option_dte}")

        if order.side == Side.BUY:
            if account.options_level < 2:
                reasons.append("account options level < 2: buying options not permitted")
            if account.equity > 0 and notional / account.equity > L.max_option_premium_pct:
                reasons.append(f"premium {notional:,.2f} is {notional / account.equity:.1%} of equity "
                               f"> max_option_premium_pct {L.max_option_premium_pct:.0%}")
            long_opts = sum(p.market_value for p in self.broker.get_positions()
                            if p.asset_class == AssetClass.OPTION and p.qty > 0)
            if account.equity > 0 and (long_opts + notional) / account.equity > L.max_total_option_pct:
                reasons.append(f"total long option exposure would exceed {L.max_total_option_pct:.0%} of equity")
            return

        # Selling to open: must be covered unless naked is explicitly allowed.
        if L.allow_naked_options:
            warnings.append("naked option selling is enabled")
            return
        contracts_short_after = order.qty - max(held, 0)
        if contract.right == OptionRight.CALL:
            shares = self.broker.get_position(contract.underlying)
            have = shares.qty if shares else 0
            already_short = sum(-p.qty for p in self.broker.get_positions()
                                if p.asset_class == AssetClass.OPTION and p.qty < 0
                                and OptionContract.from_occ(p.symbol).underlying == contract.underlying
                                and OptionContract.from_occ(p.symbol).right == OptionRight.CALL)
            need = (already_short + contracts_short_after) * 100
            if have < need:
                reasons.append(f"covered call requires {need:g} shares of {contract.underlying}, have {have:g}")
        else:
            collateral = contract.strike * 100 * contracts_short_after
            if account.buying_power < collateral:
                reasons.append(f"cash-secured put needs {collateral:,.2f} cash, buying power "
                               f"{account.buying_power:,.2f}")
            if account.options_level < 1:
                reasons.append("account options level < 1")
