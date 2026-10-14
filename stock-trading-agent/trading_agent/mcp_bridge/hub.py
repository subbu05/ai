"""Synchronous facade over async MCP client sessions.

The rest of the project is synchronous, while the MCP SDK is async and stdio
servers are long-lived subprocesses. ``McpHub`` runs one event loop in a
daemon thread. Each server gets an "owner" task that holds its ``Client``
open until ``close()``, and tool calls are scheduled onto that loop from the
calling thread.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from dataclasses import dataclass
from typing import Any

from .config import McpServerConfig

# Extra variables passed to stdio servers on top of the SDK's safe defaults
# (PATH, HOME, ...), so tools like `uvx` can reach the network behind a proxy.
_PASSTHROUGH_ENV = ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
                    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "UV_CACHE_DIR", "UV_INDEX_URL")


@dataclass
class RemoteTool:
    server: str
    name: str
    description: str
    input_schema: dict[str, Any]
    annotations: Any = None


class McpError(RuntimeError):
    pass


class McpHub:
    def __init__(self, call_timeout: float = 60.0, connect_timeout: float = 120.0):
        self.call_timeout = call_timeout
        self.connect_timeout = connect_timeout
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="mcp-hub", daemon=True)
        self._thread.start()
        self._clients: dict[str, Any] = {}
        self._stops: dict[str, asyncio.Event] = {}
        self._owners: dict[str, asyncio.Future] = {}
        self.tools: dict[str, list[RemoteTool]] = {}

    # ------------------------------------------------------------- lifecycle
    def _run(self, coro, timeout: float):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(timeout)

    def connect(self, cfg: McpServerConfig, target: Any = None) -> list[RemoteTool]:
        """Start/attach to a server and list its tools. ``target`` overrides the
        transport (an in-process ``mcp.server.lowlevel.Server`` in tests)."""
        if cfg.name in self._clients:
            return self.tools[cfg.name]
        ready: asyncio.Future | None = None  # created inside the loop by start()

        async def start():
            nonlocal ready
            ready = asyncio.get_running_loop().create_future()
            stop = asyncio.Event()
            self._stops[cfg.name] = stop
            self._owners[cfg.name] = asyncio.ensure_future(self._own(cfg, target, ready, stop))
            return await ready

        try:
            tools = self._run(start(), self.connect_timeout)
        except Exception as e:
            self._stops.pop(cfg.name, None)
            root = _root_cause(e)
            raise McpError(f"could not connect to MCP server {cfg.name!r}: "
                           f"{type(root).__name__}: {root}") from e
        self.tools[cfg.name] = tools
        return tools

    async def _own(self, cfg, target, ready: asyncio.Future, stop: asyncio.Event) -> None:
        from mcp import Client

        try:
            kwargs = {} if target is not None else {"mode": cfg.protocol}
            async with Client(target if target is not None else _transport(cfg), **kwargs) as client:
                tools = await _list_all(client, cfg.name)
                self._clients[cfg.name] = client
                ready.set_result(tools)
                await stop.wait()
        except BaseException as e:  # surface startup failures to connect()
            if not ready.done():
                ready.set_exception(e if isinstance(e, Exception) else McpError(repr(e)))
            elif not isinstance(e, asyncio.CancelledError):
                raise
        finally:
            self._clients.pop(cfg.name, None)

    def close(self) -> None:
        async def stop_all():
            for ev in self._stops.values():
                ev.set()
            owners = list(self._owners.values())
            if owners:
                await asyncio.wait(owners, timeout=10)

        if self._loop.is_running():
            try:
                self._run(stop_all(), 15)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)
        self._clients.clear()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ----------------------------------------------------------------- calls
    def call(self, server: str, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        client = self._clients.get(server)
        if client is None:
            raise McpError(f"MCP server {server!r} is not connected")

        async def go():
            return await client.call_tool(tool, args, read_timeout_seconds=self.call_timeout)

        result = self._run(go(), self.call_timeout + 5)
        return _result_to_dict(result)


def _root_cause(e: BaseException) -> BaseException:
    """Unwrap anyio/asyncio ExceptionGroups to the first real error."""
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    return e


def _transport(cfg: McpServerConfig):
    if cfg.transport == "stdio":
        from mcp import StdioServerParameters

        env = {k: os.environ[k] for k in _PASSTHROUGH_ENV if k in os.environ}
        env.update(cfg.env)
        return StdioServerParameters(command=cfg.command, args=cfg.args, env=env)
    if cfg.headers:
        import httpx2
        from mcp.client.streamable_http import streamable_http_client

        return streamable_http_client(cfg.url, http_client=httpx2.AsyncClient(headers=cfg.headers, timeout=60))
    return cfg.url


async def _list_all(client, server: str) -> list[RemoteTool]:
    tools: list[RemoteTool] = []
    cursor = None
    while True:
        page = await client.list_tools(cursor=cursor)
        for t in page.tools:
            tools.append(RemoteTool(server, t.name, t.description or "", dict(t.input_schema or {}),
                                    t.annotations))
        cursor = page.next_cursor
        if not cursor:
            return tools


def _result_to_dict(result) -> dict[str, Any]:
    out: dict[str, Any] = {"is_error": bool(result.is_error)}
    if result.structured_content is not None:
        out["data"] = result.structured_content
    texts = []
    for block in result.content or []:
        if getattr(block, "type", None) == "text":
            try:
                texts.append(json.loads(block.text))
            except (json.JSONDecodeError, TypeError):
                texts.append(block.text)
        else:
            texts.append({"type": getattr(block, "type", "unknown")})
    if texts and "data" not in out:
        out["data"] = texts[0] if len(texts) == 1 else texts
    return out
