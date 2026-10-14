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

Accounts, monitoring and P&L:
    python -m trading_agent secrets init / set alpaca.api_key_id / check / install-hook
    python -m trading_agent monitor --interval 300      # daily price tracking + profit protection
    python -m trading_agent pnl                          # realized / unrealized P&L summary
    python -m trading_agent report                       # HTML charts -> reports/pnl_dashboard.html
    python -m trading_agent ui                           # web UI: watchlist, labels, click-to-trade
    python -m trading_agent watch add AAPL --label Tech  # watchlist from the command line
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


def _secrets_command(args) -> int:
    import getpass
    import shutil
    import subprocess

    from . import credentials as cred

    path = cred.secrets_path()
    try:
        if args.secrets_cmd == "path":
            print(path)
        elif args.secrets_cmd == "init":
            print(f"Created {cred.init_secrets(path, force=args.force)} (mode 600). "
                  "Fill it in with: python -m trading_agent secrets set <section.key>")
        elif args.secrets_cmd == "set":
            value = sys.stdin.readline().strip() if args.stdin else getpass.getpass(f"{args.key}: ")
            cred.set_secret(args.key, value, path, use_keyring=args.keyring)
            print(f"Saved {args.key} to {'OS keychain' if args.keyring else path}")
        elif args.secrets_cmd == "check":
            problems, rows = cred.status(path)
            print(f"Accounts file: {path} ({'exists' if path.exists() else 'not created - run secrets init'})")
            for p in problems:
                print(f"  PROBLEM: {p}")
            env_file = PROJECT_ROOT / ".env"
            if env_file.exists():
                for p in (cred.permission_problem(env_file), cred.git_problem(env_file)):
                    if p:
                        print(f"  PROBLEM: {p}")
            for r in rows:
                print(f"  {r.setting:28s} {r.source:8s} {r.preview}")
            return 1 if problems else 0
        elif args.secrets_cmd == "install-hook":
            top = subprocess.run(["git", "-C", str(PROJECT_ROOT), "rev-parse", "--git-path", "hooks"],
                                 capture_output=True, text=True)
            if top.returncode != 0:
                print("not inside a git repository", file=sys.stderr)
                return 2
            hooks = Path(top.stdout.strip())
            hooks = hooks if hooks.is_absolute() else PROJECT_ROOT / hooks
            dest = hooks / "pre-commit"
            if dest.exists() and not args.force:
                print(f"{dest} already exists (use --force to replace)", file=sys.stderr)
                return 2
            hooks.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PROJECT_ROOT / "scripts" / "pre-commit-secrets.py", dest)
            dest.chmod(0o755)
            print(f"Installed {dest}")
    except cred.SecretsError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 0


def _watch_command(args, settings: Settings) -> int:
    from .watchlist import Watchlist

    wl = Watchlist(settings.data_dir / "watchlist.json")
    try:
        if args.watch_cmd == "add":
            item = wl.add(args.symbol, args.label, monitor=not args.no_monitor)
            print(f"Watching {item.symbol} labels={item.labels} monitor={item.monitor}")
        elif args.watch_cmd == "remove":
            print("Removed" if wl.remove(args.symbol) else "Not on the watchlist")
        elif args.watch_cmd == "label":
            print(wl.update(args.symbol, labels=args.labels).labels)
        elif args.watch_cmd == "monitor":
            print(wl.update(args.symbol, monitor=args.state == "on"))
        elif args.watch_cmd == "list":
            items = wl.filter(args.label or None)
            if args.group:
                for label, syms in wl.grouped(items).items():
                    print(f"{label}: {', '.join(syms)}")
            else:
                for i in items:
                    print(f"{i.symbol:8s} {'monitor' if i.monitor else '       '}  {', '.join(i.labels)}")
    except (ValueError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 0


def _ui_command(args, settings: Settings, registry) -> int:
    import webbrowser

    from .webui.server import TradingApp, make_server

    ctx = build_context(args, settings)
    app = TradingApp(ctx, registry, simulate=args.simulate and settings.broker == "paper",
                     monitor_interval=args.interval)
    try:
        server, token = make_server(app, args.port)
    except OSError as e:
        print(f"could not listen on 127.0.0.1:{args.port}: {e}", file=sys.stderr)
        return 2
    url = f"http://127.0.0.1:{server.server_address[1]}/#token={token}"
    if args.monitor:
        app.set_monitor(True)
    print(f"Trading UI ({settings.trading_mode}) running at:\n  {url}\n"
          "Only this computer can reach it. Keep the link private (it carries the session token). Ctrl+C to stop.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
        server.server_close()
    return 0


def _tracking_command(args, settings: Settings) -> int:
    from .dashboard import write_dashboard
    from .monitor import PriceTracker, ProfitProtectConfig, market_open, run_check
    from .pnl import EquityHistory, PnlLedger, pnl_report

    ctx = build_context(args, settings)
    data = settings.data_dir
    ledger = PnlLedger(data / "fills.jsonl")
    if args.cmd == "pnl":
        report = pnl_report(ctx.broker, ledger)
        report.pop("open_positions", None)
        _print(report)
        return 0
    if args.cmd == "report":
        out = Path(args.out)
        out = out if out.is_absolute() else PROJECT_ROOT / out
        print(f"Wrote {write_dashboard(ctx.broker, data, out, settings.trading_mode)}")
        return 0

    from .watchlist import Watchlist

    cfg = ProfitProtectConfig.load()
    tracker = PriceTracker(data / "price_tracker.json", data / "price_log.jsonl")
    equity = EquityHistory(data / "equity_history.jsonl")
    watchlist = Watchlist(data / "watchlist.json")
    print(f"Profit protection: sell all of a profitable stock/ETF after a {cfg.drop_pct:.0%} drop from "
          f"{cfg.reference.replace('_', ' ')}, never below cost. "
          f"{'DRY RUN' if args.dry_run else 'auto-sell' if cfg.auto_sell else 'asks before selling'}"
          f"{' (live: asks unless auto_sell_live)' if settings.is_live and not cfg.auto_sell_live else ''}")
    n = 0
    while True:
        n += 1
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        if args.simulate and hasattr(ctx.broker, "tick"):
            ctx.broker.tick()
        if cfg.respect_market_hours and not args.ignore_hours and not market_open(ctx.broker):
            print(f"[{stamp}] market closed; skipping")
        else:
            for d in run_check(ctx, cfg, tracker, execute=not args.dry_run, watchlist=watchlist):
                extra = f" -> {d.result}" if d.result else ""
                trig = f" trigger {d.trigger:.2f}" if d.trigger else ""
                print(f"[{stamp}] {d.symbol:6s} {d.action:12s} price {d.price:.2f} cost {d.avg_cost:.2f}"
                      f"{trig}{extra}  ({d.reason})")
            equity.snapshot(ctx.broker)
            ledger.sync(ctx.broker)
        if args.once or (args.iterations and n >= args.iterations):
            return 0
        time.sleep(args.interval)


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

    p = sub.add_parser("secrets", help="manage the local (git-ignored) trading accounts file")
    ssub = p.add_subparsers(dest="secrets_cmd", required=True)
    sp = ssub.add_parser("init", help="create the accounts file (chmod 600) from the template")
    sp.add_argument("--force", action="store_true")
    ssub.add_parser("check", help="show which credentials are set (masked) and verify file safety")
    ssub.add_parser("path", help="print the accounts file location")
    sp = ssub.add_parser("set", help="set one value, e.g. alpaca.api_key_id (prompts without echo)")
    sp.add_argument("key")
    sp.add_argument("--keyring", action="store_true", help="store in the OS keychain instead of the file")
    sp.add_argument("--stdin", action="store_true", help="read the value from stdin")
    sp = ssub.add_parser("install-hook", help="install a git pre-commit hook that blocks committing secrets")
    sp.add_argument("--force", action="store_true")

    p = sub.add_parser("monitor", help="track holdings' prices and apply the profit-protection rule")
    p.add_argument("--once", action="store_true", help="run a single check (for cron)")
    p.add_argument("--interval", type=int, default=300, help="seconds between checks (default 300)")
    p.add_argument("--iterations", type=int, default=0, help="0 = until stopped")
    p.add_argument("--dry-run", action="store_true", help="report decisions but never sell")
    p.add_argument("--simulate", action="store_true", help="paper only: move simulated prices each check")
    p.add_argument("--ignore-hours", action="store_true", help="check even when the market is closed")
    p = sub.add_parser("ui", help="local web UI: watchlist, labels, filters, click-to-trade, monitor")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--monitor", action="store_true", help="start profit protection immediately")
    p.add_argument("--interval", type=int, default=300, help="monitor interval in seconds")
    p.add_argument("--simulate", action="store_true", help="paper only: move simulated prices")
    p.add_argument("--no-browser", action="store_true")
    p = sub.add_parser("watch", help="manage the watchlist from the command line")
    wsub = p.add_subparsers(dest="watch_cmd", required=True)
    wp = wsub.add_parser("add", help="add a ticker, e.g. watch add AAPL --label Tech --label Core")
    wp.add_argument("symbol")
    wp.add_argument("--label", action="append", default=[])
    wp.add_argument("--no-monitor", action="store_true")
    wp = wsub.add_parser("remove")
    wp.add_argument("symbol")
    wp = wsub.add_parser("label", help="set a ticker's labels (replaces them)")
    wp.add_argument("symbol")
    wp.add_argument("labels", nargs="*")
    wp = wsub.add_parser("monitor", help="turn profit protection on/off for a ticker")
    wp.add_argument("symbol")
    wp.add_argument("state", choices=["on", "off"])
    wp = wsub.add_parser("list")
    wp.add_argument("--label", action="append", default=[], help="filter (any of)")
    wp.add_argument("--group", action="store_true", help="group by label")
    sub.add_parser("pnl", help="realized profit / loss summary")
    p = sub.add_parser("report", help="write the HTML P&L dashboard")
    p.add_argument("--out", default="reports/pnl_dashboard.html")

    args = parser.parse_args(argv)
    if args.cmd == "secrets":
        return _secrets_command(args)
    try:
        settings = Settings.from_env()
    except Exception as e:  # SecretsError, bad config
        print(f"configuration error: {e}", file=sys.stderr)
        return 2

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

    if args.cmd in ("monitor", "pnl", "report"):
        return _tracking_command(args, settings)
    if args.cmd == "watch":
        return _watch_command(args, settings)
    if args.cmd == "ui":
        return _ui_command(args, settings, registry)

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
