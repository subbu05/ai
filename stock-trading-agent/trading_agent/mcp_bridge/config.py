"""Load broker MCP server definitions from config/mcp_servers.toml.

Values may reference environment variables as ``${VAR}`` or ``${VAR:-default}``.
A server whose required variables are unset is reported as unavailable rather
than started with blank credentials.
"""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from ..config import PROJECT_ROOT

DEFAULT_MCP_FILE = PROJECT_ROOT / "config" / "mcp_servers.toml"
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


class MissingEnv(ValueError):
    def __init__(self, names: list[str]):
        super().__init__(f"missing environment variables: {', '.join(names)}")
        self.names = names


def expand(value: str, missing: list[str]) -> str:
    def sub(m: re.Match) -> str:
        name, default = m.group(1), m.group(2)
        v = os.environ.get(name, "")
        if v:
            return v
        if default is not None:
            return default
        missing.append(name)
        return ""
    return _VAR.sub(sub, value)


@dataclass
class McpServerConfig:
    name: str
    transport: str                       # "stdio" | "http"
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    enabled: bool = False
    read_only: bool = False              # hide every tool that can change the account
    live: bool = False                   # trades real money
    live_if_env: dict[str, str] = field(default_factory=dict)
    trade_tools: list[str] = field(default_factory=list)   # regexes; override heuristics
    read_tools: list[str] = field(default_factory=list)
    description: str = ""
    unofficial: bool = False
    protocol: str = "auto"               # "auto" probes the 2026 protocol first; "legacy" = initialize handshake

    def resolved(self) -> "McpServerConfig":
        """Return a copy with ${VAR} expanded. Raises MissingEnv."""
        missing: list[str] = []
        out = McpServerConfig(
            name=self.name, transport=self.transport,
            command=expand(self.command, missing),
            args=[a for a in (expand(a, missing) for a in self.args) if a],  # drop empty optional args
            env={k: v for k, v in ((k, expand(v, missing)) for k, v in self.env.items()) if v},
            url=expand(self.url, missing),
            headers={k: expand(v, missing) for k, v in self.headers.items()},
            enabled=self.enabled, read_only=self.read_only, live=self.live,
            live_if_env=self.live_if_env, trade_tools=self.trade_tools, read_tools=self.read_tools,
            description=self.description, unofficial=self.unofficial, protocol=self.protocol,
        )
        if missing:
            raise MissingEnv(sorted(set(missing)))
        if out.transport == "stdio" and not out.command:
            raise ValueError(f"{self.name}: stdio server needs a command")
        if out.transport == "http" and not out.url:
            raise ValueError(f"{self.name}: http server needs a url")
        if out.live_if_env:
            # Live when every listed variable (server env first, then process env) has the value.
            out.live = out.live or all(
                (out.env.get(k) or os.environ.get(k, "")).lower() == v.lower()
                for k, v in out.live_if_env.items())
        return out


def load_mcp_servers(path: Path | None = None) -> dict[str, McpServerConfig]:
    path = path or Path(os.getenv("MCP_CONFIG", DEFAULT_MCP_FILE))
    if not path.exists():
        return {}
    with path.open("rb") as fh:
        raw = tomllib.load(fh).get("servers", {})
    servers = {}
    for name, spec in raw.items():
        transport = spec.pop("transport", "stdio")
        if transport not in ("stdio", "http"):
            raise ValueError(f"{name}: transport must be 'stdio' or 'http'")
        servers[name] = McpServerConfig(name=name, transport=transport, **spec)
    return servers


def selected_servers(all_servers: dict[str, McpServerConfig], names: str | None) -> list[McpServerConfig]:
    """``names`` is a comma list (CLI --mcp / MCP_SERVERS env); default = enabled ones."""
    names = names if names is not None else os.getenv("MCP_SERVERS")
    if names:
        wanted = [n.strip() for n in names.split(",") if n.strip()]
        unknown = [n for n in wanted if n not in all_servers]
        if unknown:
            raise ValueError(f"unknown MCP servers {unknown}; configured: {sorted(all_servers)}")
        return [all_servers[n] for n in wanted]
    return [s for s in all_servers.values() if s.enabled]
