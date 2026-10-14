"""MCP integration: connect to broker MCP servers and serve our own skills over MCP."""

from __future__ import annotations

from dataclasses import dataclass, field

from ..skills.base import SkillRegistry
from .config import McpServerConfig, MissingEnv, load_mcp_servers, selected_servers
from .hub import McpError, McpHub


@dataclass
class ServerStatus:
    name: str
    status: str            # connected | skipped | error
    detail: str = ""
    live: bool = False
    skills: list[str] = field(default_factory=list)


def connect_servers(registry: SkillRegistry, hub: McpHub, configs: list[McpServerConfig],
                    live_ack: bool = False) -> list[ServerStatus]:
    from .skills import register_server

    statuses = []
    for raw in configs:
        try:
            cfg = raw.resolved()
        except MissingEnv as e:
            statuses.append(ServerStatus(raw.name, "skipped", str(e)))
            continue
        except ValueError as e:
            statuses.append(ServerStatus(raw.name, "error", str(e)))
            continue
        if cfg.live and not cfg.read_only and not live_ack:
            statuses.append(ServerStatus(cfg.name, "skipped",
                                         "live account: pass --i-understand-live-trading "
                                         "(or set read_only = true)", live=True))
            continue
        try:
            tools = hub.connect(cfg)
        except McpError as e:
            statuses.append(ServerStatus(cfg.name, "error", str(e), cfg.live))
            continue
        added = register_server(registry, hub, cfg, tools)
        statuses.append(ServerStatus(cfg.name, "connected", f"{len(added)} tools", cfg.live, added))
    return statuses


__all__ = ["McpHub", "McpError", "McpServerConfig", "MissingEnv", "ServerStatus", "connect_servers",
           "load_mcp_servers", "selected_servers"]
