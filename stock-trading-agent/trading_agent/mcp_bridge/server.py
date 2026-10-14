"""Serve this project's skills as an MCP server (stdio).

Lets Claude Code, Claude Desktop, Cursor and other MCP clients use the
risk-checked skills directly:

    python -m trading_agent mcp serve

stdin/stdout carry the protocol, so there's no terminal for a y/N prompt.
Approval works like this instead:
* paper / alpaca-paper: orders that pass the risk engine are executed. The
  MCP client's own tool-permission prompt is the human check.
* alpaca-live: order skills return ``declined_by_user`` unless the server was
  started with ``--allow-live-orders`` (and the CLI's live acknowledgement flag).
"""

from __future__ import annotations

import json
from typing import Any

from ..skills import SkillContext, SkillRegistry


def build_server(ctx: SkillContext, registry: SkillRegistry, name: str = "trading-agent"):
    import mcp_types as types
    from mcp.server.lowlevel import Server

    def tool_def(skill) -> "types.Tool":
        return types.Tool(
            name=skill.name,
            description=skill.description,
            input_schema=skill.input_schema,
            annotations=types.ToolAnnotations(
                read_only_hint=not skill.places_orders,
                destructive_hint=skill.places_orders,
                open_world_hint=True,
            ),
        )

    async def on_list_tools(_ctx, _params) -> "types.ListToolsResult":
        return types.ListToolsResult(tools=[tool_def(s) for s in registry.all()])

    async def on_call_tool(_ctx, params) -> "types.CallToolResult":
        args: dict[str, Any] = dict(params.arguments or {})
        try:
            result = registry.get(params.name).run(ctx, **args)
            is_error = False
        except Exception as e:
            result, is_error = {"error": f"{type(e).__name__}: {e}"}, True
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=json.dumps(result, default=str))],
            is_error=is_error,
        )

    return Server(
        name,
        version="0.2.0",
        instructions=("Risk-checked trading skills for stocks, ETFs and options. Order skills accept "
                      "dry_run=true for a preview. Rejections by the risk engine are final; do not "
                      "split orders to get around limits."),
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )


def serve_stdio(ctx: SkillContext, registry: SkillRegistry) -> None:
    import anyio
    from mcp.server.stdio import stdio_server

    server = build_server(ctx, registry)

    async def main():
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())

    anyio.run(main)
