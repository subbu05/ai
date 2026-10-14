"""Command line interface.

Examples:
    python -m trading_agent skills
    python -m trading_agent run get_quote symbols='["AAPL","SPY"]'
    python -m trading_agent run buy_etf symbol=VTI notional=5000 reason="core holding"
    python -m trading_agent ask "Sell a 30-delta covered call on my AAPL shares"
    python -m trading_agent chat
    python -m trading_agent autopilot --task-file config/autopilot_task.md --interval 3600
    python -m trading_agent kill        # engage kill switch

Broker MCP servers (see docs/MCP.md):
    python -m trading_agent mcp servers
    python -m trading_agent --mcp alpaca mcp tools alpaca
    python -m trading_agent --mcp alpaca,webull chat
    python -m trading_agent mcp serve   # expose these skills to Claude Code / Desktop
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .brokers import create_broker
from .config import PROJECT_ROOT, Settings
from .journal import TradeJournal
from .models import Order
from .risk import RiskDecision, RiskManager
from .skills import SkillContext, auto_approve, confirm_all, default_registry, deny_all


def _ask(prompt: str) -> bool:
    try:
        return input(prompt).strip().lower() in ("y", "yes")
    except EOFError:
        return False


def interactive_approver(order: Order, decision: RiskDecision) -> bool:
    print("\n" + "=" * 60)
    print(f"ORDER: {order.side.value.upper()} {order.qty:g} {order.symbol} "
          f"({order.asset_class.value}, {order.order_type.value}"
          f"{f' @ {order.limit_price}' if order.limit_price else ''}"
          f"{f' stop {order.stop_price}' if order.stop_price else ''})")
    print(f"Est. notional: ${decision.est_notional:,.2f}")
    if order.reason:
        print(f"Reason: {order.reason}")
    for w in decision.warnings:
        print(f"  ! {w}")
    print("=" * 60)
    return _ask("Approve this order? [y/N] ")


def interactive_confirm(summary: str, details: dict) -> bool:
    print("\n" + "=" * 60)
    print(f"MCP {details.get('kind', 'action').upper()}: {summary}")
    print(json.dumps(details.get("args", {}), indent=2, default=str))
    for w in details.get("warnings", []):
        print(f"  ! {w}")
    print("=" * 60)
    return _ask("Approve this action? [y/N] ")


def build_context(args, settings: Settings) -> SkillContext:
    broker = create_broker(settings)
    auto = getattr(args, "yes", False) or (not settings.require_approval and not settings.is_live)
    approver = auto_approve if auto else interactive_approver

    def confirm(summary: str, details: dict) -> bool:
        # Live broker MCP actions always need a human, even with --yes.
        if auto and not details.get("live"):
            return True
        return interactive_confirm(summary, details)

    return SkillContext(broker, RiskManager(broker, settings.risk), TradeJournal(settings.journal_file),
                        settings, approver, confirm)


def parse_kv(pairs: list[str]) -> dict:
    out = {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"argument {pair!r} must be key=value")
        k, v = pair.split("=", 1)
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v
    return out


def _print(obj) -> None:
    print(json.dumps(obj, indent=2, default=str))


def _kill_file(settings: Settings) -> Path:
    p = Path(settings.risk.kill_switch_file)
    return p if p.is_absolute() else PROJECT_ROOT / p


def _mcp_instructions(statuses) -> str:
    connected = [s for s in statuses if s.status == "connected"]
    if not connected:
        return ""
    lines = ["", "Connected broker accounts via MCP (tool names are prefixed `<broker>__`):"]
    for s in connected:
        lines.append(f"- {s.name}{' (LIVE, real money)' if s.live else ' (paper/sandbox)'}")
    lines += [
        "Tools without a prefix act on the built-in broker above. If the user hasn't said which "
        "account to use, ask before placing any order.",
        "For broker MCP orders, use the broker's preview/review tool first when it has one. "
        "Never split an order to get around a guard rejection.",
    ]
    return "\n".join(lines)


def _attach_mcp(args, registry, quiet: bool = False):
    """Connect the selected broker MCP servers. Returns (hub, statuses) or (None, [])."""
    from .mcp_bridge import McpHub, connect_servers, load_mcp_servers, selected_servers

    configs = selected_servers(load_mcp_servers(), args.mcp)
    if not configs:
        return None, []
    hub = McpHub()
    statuses = connect_servers(registry, hub, configs, live_ack=args.live_ack)
    if not quiet:
        for s in statuses:
            print(f"[mcp] {s.name}: {s.status}{' - ' + s.detail if s.detail else ''}", file=sys.stderr)
    return hub, statuses


def _make_agent(ctx: SkillContext, registry, verbose: bool, extra: str = ""):
    from .agent import TradingAgent

    def on_tool(name, args, output):
        if verbose:
            print(f"  -> {name}({json.dumps(args, default=str)})")
            status = output.get("status") if isinstance(output, dict) else None
            if status:
                print(f"     status: {status}")

    return TradingAgent(ctx, registry, on_tool=on_tool, extra_instructions=extra)


def _mcp_command(args, settings: Settings, registry) -> int:
    from .mcp_bridge import MissingEnv, load_mcp_servers
    from .mcp_bridge.guard import classify

    servers = load_mcp_servers()
    if args.mcp_cmd == "servers":
        for name, cfg in servers.items():
            try:
                r = cfg.resolved()
                state = "ready"
                live = "LIVE" if r.live else "paper/sandbox"
            except MissingEnv as e:
                state, live = f"needs {', '.join(e.names)}", "LIVE" if cfg.live else "?"
            except ValueError as e:
                state, live = str(e), "?"
            flags = [f for f, on in (("enabled", cfg.enabled), ("read-only", cfg.read_only),
                                     ("UNOFFICIAL", cfg.unofficial)) if on]
            print(f"{name:10s} {cfg.transport:5s} {live:13s} {state:40s} {' '.join(flags)}")
            if cfg.description:
                print(f"{'':10s} {cfg.description}")
        return 0

    if args.mcp_cmd == "tools":
        if args.server not in servers:
            print(f"unknown server {args.server!r}; configured: {sorted(servers)}", file=sys.stderr)
            return 2
        args.mcp = args.server
        hub, statuses = _attach_mcp(args, registry)
        try:
            if not statuses or statuses[0].status != "connected":
                return 1
            cfg = servers[args.server].resolved()
            for t in hub.tools[args.server]:
                kind = classify(t.name, cfg, t.annotations)
                hidden = " (hidden: read_only)" if cfg.read_only and kind != "read" else ""
                print(f"{kind:6s} {t.name}{hidden}")
            return 0
        finally:
            hub.close()

    if args.mcp_cmd == "serve":
        from .mcp_bridge.server import serve_stdio

        ctx = build_context(args, settings)
        ctx.approver = auto_approve if (not settings.is_live or args.allow_live_orders) else deny_all
        ctx.confirm_action = confirm_all
        serve_stdio(ctx, registry)
        return 0
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trading_agent", description="Automated stock/ETF/options agent")
    parser.add_argument("--yes", action="store_true",
                        help="auto-approve orders (not allowed for live accounts)")
    parser.add_argument("--i-understand-live-trading", action="store_true", dest="live_ack",
                        help="required for TRADING_MODE=alpaca-live and for live broker MCP servers")
    parser.add_argument("--mcp", metavar="SERVERS", default=None,
                        help="comma-separated broker MCP servers to connect (see `mcp servers`)")
    parser.add_argument("-q", "--quiet", action="store_true", help="hide tool-call trace in agent mode")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("skills", help="list available skills")
    p = sub.add_parser("describe", help="show a skill's input schema")
    p.add_argument("skill")
    p = sub.add_parser("run", help="run a skill directly: run <skill> key=value ...")
    p.add_argument("skill")
    p.add_argument("params", nargs="*")
    sub.add_parser("account")
    sub.add_parser("positions")
    p = sub.add_parser("quote")
    p.add_argument("symbols", nargs="+")
    p = sub.add_parser("journal")
    p.add_argument("-n", type=int, default=20)
    p = sub.add_parser("ask", help="one-shot request to the Claude agent")
    p.add_argument("prompt")
    sub.add_parser("chat", help="interactive session with the Claude agent")
    p = sub.add_parser("autopilot", help="run the agent on a task repeatedly")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--task")
    g.add_argument("--task-file")
    p.add_argument("--interval", type=int, default=3600, help="seconds between runs")
    p.add_argument("--iterations", type=int, default=0, help="0 = run forever")
    sub.add_parser("kill", help="engage the kill switch (halts all trading)")
    sub.add_parser("resume", help="release the kill switch")

    p = sub.add_parser("mcp", help="broker MCP servers and serving skills over MCP")
    msub = p.add_subparsers(dest="mcp_cmd", required=True)
    msub.add_parser("servers", help="list configured broker MCP servers")
    mp = msub.add_parser("tools", help="connect to one server and list its tools")
    mp.add_argument("server")
    mp = msub.add_parser("serve", help="serve this project's skills over MCP (stdio)")
    mp.add_argument("--allow-live-orders", action="store_true",
                    help="let order skills execute in alpaca-live mode (needs --i-understand-live-trading)")

    args = parser.parse_args(argv)
    settings = Settings.from_env()

    if settings.is_live and not args.live_ack:
        print("TRADING_MODE=alpaca-live: real money. Re-run with --i-understand-live-trading.", file=sys.stderr)
        return 2
    if settings.is_live and args.yes:
        print("--yes is not allowed in live mode; every live order must be approved.", file=sys.stderr)
        return 2

    if args.cmd == "kill":
        _kill_file(settings).touch()
        print(f"Kill switch engaged: {_kill_file(settings)}")
        return 0
    if args.cmd == "resume":
        _kill_file(settings).unlink(missing_ok=True)
        print("Kill switch released.")
        return 0

    registry = default_registry()
    if args.cmd == "mcp":
        return _mcp_command(args, settings, registry)
    if args.cmd == "describe":
        _print(registry.get(args.skill).to_tool())
        return 0

    hub, statuses = (None, [])
    if args.cmd in ("skills", "run", "ask", "chat", "autopilot"):
        hub, statuses = _attach_mcp(args, registry)
    try:
        return _dispatch(args, settings, registry, statuses)
    finally:
        if hub:
            hub.close()


def _dispatch(args, settings: Settings, registry, statuses) -> int:
    if args.cmd == "skills":
        for s in registry.all():
            flag = "[orders]" if s.places_orders else "        "
            print(f"{s.name:24s} {flag} {s.description[:110]}")
        return 0

    ctx = build_context(args, settings)
    extra = _mcp_instructions(statuses)
    if args.cmd == "run":
        _print(registry.get(args.skill).run(ctx, **parse_kv(args.params)))
    elif args.cmd == "account":
        _print(registry.get("get_account").run(ctx))
    elif args.cmd == "positions":
        _print(registry.get("get_positions").run(ctx))
    elif args.cmd == "quote":
        _print(registry.get("get_quote").run(ctx, symbols=args.symbols))
    elif args.cmd == "journal":
        _print(ctx.journal.tail(args.n))
    elif args.cmd == "ask":
        print(_make_agent(ctx, registry, not args.quiet, extra).ask(args.prompt))
    elif args.cmd == "chat":
        agent = _make_agent(ctx, registry, not args.quiet, extra)
        print(f"Trading agent ({settings.trading_mode}). Type 'exit' to quit.")
        while True:
            try:
                line = input("\nyou> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if line.lower() in ("exit", "quit"):
                break
            if line:
                print("\nagent> " + agent.ask(line))
    elif args.cmd == "autopilot":
        task = args.task or Path(args.task_file).read_text()
        n = 0
        while True:
            n += 1
            print(f"\n--- autopilot run {n} ({time.strftime('%Y-%m-%d %H:%M:%S')}) ---")
            agent = _make_agent(ctx, registry, not args.quiet, extra)  # fresh context each run
            try:
                print(agent.ask(task))
            except Exception as e:  # keep the loop alive; the error is logged
                ctx.journal.record("autopilot_error", error=str(e))
                print(f"error: {e}", file=sys.stderr)
            if args.iterations and n >= args.iterations:
                break
            time.sleep(args.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
