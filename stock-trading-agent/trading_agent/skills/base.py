"""Skill framework.

A *skill* is a named, schema-described capability (get a quote, buy a stock,
sell a covered call, rebalance...). Skills are exposed identically to the CLI
and to the Claude agent as tools. All order-placing skills go through
``SkillContext.execute_order`` so risk checks, approvals and journaling can
never be skipped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..brokers.base import Broker, BrokerError
from ..config import Settings
from ..journal import TradeJournal
from ..models import Order, OrderStatus
from ..risk import RiskDecision, RiskManager

Approver = Callable[[Order, RiskDecision], bool]
# Approval for actions that aren't our own Order objects (e.g. broker MCP tools): (summary, details)
ActionConfirmer = Callable[[str, dict], bool]


def auto_approve(order: Order, decision: RiskDecision) -> bool:
    return True


def deny_all(order: Order, decision: RiskDecision) -> bool:
    return False


def confirm_all(summary: str, details: dict) -> bool:
    return True


def confirm_none(summary: str, details: dict) -> bool:
    return False


@dataclass
class SkillContext:
    broker: Broker
    risk: RiskManager
    journal: TradeJournal
    settings: Settings
    approver: Approver = auto_approve
    confirm_action: ActionConfirmer = confirm_all

    def execute_order(self, order: Order, dry_run: bool = False) -> dict[str, Any]:
        decision = self.risk.check(order)
        self.journal.record("proposed", order=order.to_dict(), risk=decision.to_dict(),
                            dry_run=dry_run, broker=self.broker.name)
        result: dict[str, Any] = {"order": order.to_dict(), "risk": decision.to_dict()}

        if not decision.approved:
            self.journal.record("risk_rejected", client_order_id=order.client_order_id,
                                reasons=decision.reasons)
            result["status"] = "rejected_by_risk"
            return result
        if dry_run:
            result["status"] = "preview_only"
            return result
        if not self.approver(order, decision):
            self.journal.record("declined", client_order_id=order.client_order_id)
            result["status"] = "declined_by_user"
            return result

        try:
            placed = self.broker.submit_order(order)
        except BrokerError as e:
            self.journal.record("broker_error", client_order_id=order.client_order_id, error=str(e))
            result["status"] = "broker_error"
            result["error"] = str(e)
            return result

        self.journal.record("submitted", order=placed.to_dict())
        result["order"] = placed.to_dict()
        result["status"] = placed.status.value
        if placed.status == OrderStatus.REJECTED:
            result["error"] = placed.reason
        return result


@dataclass
class Skill:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[..., dict[str, Any]]
    places_orders: bool = False
    tags: list[str] = field(default_factory=list)

    def run(self, ctx: SkillContext, **kwargs: Any) -> dict[str, Any]:
        return self.handler(ctx, **kwargs)

    def to_tool(self) -> dict[str, Any]:
        """Anthropic Messages API tool definition."""
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}

    def register(self, skill: Skill) -> Skill:
        if skill.name in self._skills:
            raise ValueError(f"duplicate skill {skill.name}")
        self._skills[skill.name] = skill
        return skill

    def get(self, name: str) -> Skill:
        try:
            return self._skills[name]
        except KeyError:
            raise KeyError(f"unknown skill {name!r}; available: {', '.join(self.names())}") from None

    def names(self) -> list[str]:
        return sorted(self._skills)

    def all(self) -> list[Skill]:
        return [self._skills[n] for n in self.names()]

    def tools(self) -> list[dict[str, Any]]:
        return [s.to_tool() for s in self.all()]


def schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or [],
            "additionalProperties": False}


ORDER_FIELDS = {
    "order_type": {"type": "string", "enum": ["market", "limit"], "default": "market",
                   "description": "Use limit for illiquid names and for all options when possible."},
    "limit_price": {"type": "number", "description": "Required when order_type is limit."},
    "reason": {"type": "string", "description": "Short rationale recorded in the trade journal."},
    "dry_run": {"type": "boolean", "default": False,
                "description": "If true, only run risk checks and return a preview; nothing is sent."},
}
