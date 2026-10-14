"""Expose a connected broker MCP server's tools as guarded skills.

A tool ``place_stock_order`` on server ``alpaca`` becomes the skill
``alpaca__place_stock_order``. Read tools pass straight through. Trade and
write tools go through ``guard.check``, then ``SkillContext.confirm_action``
(human approval), and are journaled.
"""

from __future__ import annotations

import re
from typing import Any

from ..skills.base import Skill, SkillContext, SkillRegistry
from . import guard
from .config import McpServerConfig
from .hub import McpHub, RemoteTool

SEPARATOR = "__"


def skill_name(server: str, tool: str) -> str:
    name = re.sub(r"[^a-zA-Z0-9_-]", "_", f"{server}{SEPARATOR}{tool}")
    return name[:64]  # Messages API tool-name limit


def _schema(tool: RemoteTool) -> dict[str, Any]:
    schema = dict(tool.input_schema) if tool.input_schema else {}
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    return schema


def make_handler(hub: McpHub, cfg: McpServerConfig, tool: RemoteTool, kind: str):
    def handler(ctx: SkillContext, **args: Any) -> dict:
        decision = guard.check(tool.name, args, kind, cfg, ctx.risk)
        base = {"server": cfg.name, "tool": tool.name, "kind": kind}
        if kind != guard.READ:
            ctx.journal.record("mcp_proposed", **base, args=args, guard=decision.to_dict(), live=cfg.live)
            if not decision.allowed:
                ctx.journal.record("mcp_rejected", **base, reasons=decision.reasons)
                return {**base, "status": "rejected_by_guard", "guard": decision.to_dict()}
            summary = (f"{cfg.name}{' (LIVE)' if cfg.live else ''}: {tool.name}"
                       + (f"  est. value ${decision.est_notional:,.2f}" if decision.est_notional else ""))
            if not ctx.confirm_action(summary, {"args": args, "warnings": decision.warnings,
                                                "live": cfg.live, "kind": kind}):
                ctx.journal.record("mcp_declined", **base)
                return {**base, "status": "declined_by_user"}

        result = hub.call(cfg.name, tool.name, args)
        if kind != guard.READ:
            ctx.journal.record("mcp_result", **base, result=result)
        out = {**base, "status": "error" if result["is_error"] else "ok", "result": result.get("data")}
        if decision.warnings:
            out["warnings"] = decision.warnings
        return out
    return handler


def register_server(reg: SkillRegistry, hub: McpHub, cfg: McpServerConfig,
                    tools: list[RemoteTool]) -> list[str]:
    """Register the server's tools. Returns the skill names added."""
    added = []
    for tool in tools:
        kind = guard.classify(tool.name, cfg, tool.annotations)
        if cfg.read_only and kind != guard.READ:
            continue  # never even offered to the model
        prefix = {"read": "", "trade": "[TRADES] ", "write": "[CHANGES ACCOUNT] "}[kind]
        live = "LIVE money. " if cfg.live and kind != guard.READ else ""
        desc = f"{prefix}{live}{cfg.name} broker via MCP: {tool.description}".strip()
        name = skill_name(cfg.name, tool.name)
        reg.register(Skill(name, desc[:1024], _schema(tool), make_handler(hub, cfg, tool, kind),
                           places_orders=kind == guard.TRADE, tags=["mcp", cfg.name, kind]))
        added.append(name)
    return added
