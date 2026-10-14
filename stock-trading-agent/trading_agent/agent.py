"""Claude-powered trading agent.

Claude sees every registered skill as a tool and decides which to call. The
loop is a manual tool-use loop so that every order still flows through
``SkillContext.execute_order`` (risk checks -> human approval -> broker ->
journal). Claude can never place an order the risk engine rejects.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any, Callable

import anthropic

from .skills import SkillContext, SkillRegistry

SYSTEM_PROMPT = """\
You are a disciplined trading assistant operating a brokerage account through tools.
You can trade stocks, ETFs and listed options.

Operating rules:
- Ground every decision in tool data. Before trading, check the account, current positions
  and a fresh quote; for options, inspect the chain (strike, expiry, delta, bid/ask).
- Size positions conservatively and respect the user's stated goals. If the user's request is
  ambiguous about size, symbol, strike or expiry, ask instead of guessing.
- Prefer limit orders for options and for anything with a wide spread.
- Use dry_run=true to preview when you are unsure, and for any multi-order plan (e.g.
  rebalance) show the plan first and execute only once the user confirms it.
- A pre-trade risk engine checks every order. If it rejects one, report the reasons; never try
  to work around a limit by splitting orders or changing instruments.
- Always include a one-line `reason` on order tools; it is written to the audit journal.
- After acting, summarise what was done: fills, prices, resulting positions, and open risks.
- You are not a licensed financial adviser. Present analysis as information, not advice.

Trading mode: {mode}. Broker: {broker}. Today: {today}.
"""

ToolObserver = Callable[[str, dict, dict], None]


class TradingAgent:
    def __init__(
        self,
        ctx: SkillContext,
        registry: SkillRegistry,
        client: anthropic.Anthropic | None = None,
        model: str | None = None,
        effort: str | None = None,
        max_turns: int = 25,
        on_tool: ToolObserver | None = None,
    ):
        self.ctx = ctx
        self.registry = registry
        self.client = client or anthropic.Anthropic()
        self.model = model or ctx.settings.anthropic_model
        self.effort = effort or ctx.settings.agent_effort
        self.max_turns = max_turns
        self.on_tool = on_tool
        self.messages: list[dict[str, Any]] = []
        self.system = SYSTEM_PROMPT.format(mode=ctx.settings.trading_mode, broker=ctx.broker.name,
                                           today=date.today().isoformat())

    def run_tool(self, name: str, args: dict) -> tuple[dict, bool]:
        try:
            result = self.registry.get(name).run(self.ctx, **args)
            return result, False
        except Exception as e:  # report tool failures back to Claude instead of crashing
            return {"error": f"{type(e).__name__}: {e}"}, True

    def ask(self, user_input: str) -> str:
        """Send one user message and run the tool loop until Claude finishes its turn."""
        self.messages.append({"role": "user", "content": user_input})
        for _ in range(self.max_turns):
            response = self.client.beta.messages.create(
                model=self.model,
                max_tokens=16000,
                system=self.system,
                tools=self.registry.tools(),
                messages=self.messages,
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
            # Keep the full content (including thinking blocks) for the next request.
            self.messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "refusal":
                return "The model declined this request."
            if response.stop_reason == "pause_turn":
                continue
            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if response.stop_reason != "tool_use" or not tool_uses:
                if response.stop_reason == "max_tokens":
                    return _text(response.content) + "\n[response truncated at max_tokens]"
                return _text(response.content)

            results = []
            for block in tool_uses:
                args = block.input if isinstance(block.input, dict) else json.loads(block.input)
                output, is_error = self.run_tool(block.name, args)
                if self.on_tool:
                    self.on_tool(block.name, args, output)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(output, default=str),
                    "is_error": is_error,
                })
            # All results for parallel tool calls go back in a single user message.
            self.messages.append({"role": "user", "content": results})
        return "Stopped: reached the maximum number of tool turns for one request."


def _text(content) -> str:
    return "\n".join(b.text for b in content if b.type == "text").strip()
