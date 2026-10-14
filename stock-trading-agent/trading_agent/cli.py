"""Command line interface.

Examples:
    python -m trading_agent skills
    python -m trading_agent run get_quote symbols='["AAPL","SPY"]'
    python -m trading_agent run buy_etf symbol=VTI notional=5000 reason="core holding"
    python -m trading_agent ask "Sell a 30-delta covered call on my AAPL shares"
    python -m trading_agent chat
    python -m trading_agent autopilot --task-file config/autopilot_task.md --interval 3600
    python -m trading_agent kill        # engage kill switch
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
from .skills import SkillContext, auto_approve, default_registry


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
    try:
        return input("Approve this order? [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def build_context(args, settings: Settings) -> SkillContext:
    broker = create_broker(settings)
    approver = interactive_approver
    if getattr(args, "yes", False):
        approver = auto_approve
    elif not settings.require_approval and not settings.is_live:
        approver = auto_approve
    return SkillContext(broker, RiskManager(broker, settings.risk), TradeJournal(settings.journal_file),
                        settings, approver)


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


def _make_agent(ctx: SkillContext, registry, verbose: bool):
    from .agent import TradingAgent

    def on_tool(name, args, output):
        if verbose:
            print(f"  -> {name}({json.dumps(args, default=str)})")
            status = output.get("status") if isinstance(output, dict) else None
            if status:
                print(f"     status: {status}")

    return TradingAgent(ctx, registry, on_tool=on_tool)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trading_agent", description="Automated stock/ETF/options agent")
    parser.add_argument("--yes", action="store_true", help="auto-approve orders (paper trading only by default)")
    parser.add_argument("--i-understand-live-trading", action="store_true", dest="live_ack",
                        help="required when TRADING_MODE=alpaca-live")
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
    if args.cmd == "skills":
        for s in registry.all():
            flag = "[orders]" if s.places_orders else "        "
            print(f"{s.name:24s} {flag} {s.description}")
        return 0
    if args.cmd == "describe":
        _print(registry.get(args.skill).to_tool())
        return 0

    ctx = build_context(args, settings)
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
        print(_make_agent(ctx, registry, not args.quiet).ask(args.prompt))
    elif args.cmd == "chat":
        agent = _make_agent(ctx, registry, not args.quiet)
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
            agent = _make_agent(ctx, registry, not args.quiet)  # fresh context each run
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
