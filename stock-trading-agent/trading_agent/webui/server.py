"""Local web UI: watchlist with labels, filters, grouping, click-to-trade and the
profit-protection monitor.

    python -m trading_agent ui            # http://127.0.0.1:8765/#token=...

Security model (it can place orders, so it is locked down):
* binds to 127.0.0.1 only;
* every /api call needs the random per-run token (sent as the X-Auth-Token header), which
  a page on another website cannot add without a CORS preflight that this server never grants;
* the Host header must be localhost/127.0.0.1 (blocks DNS-rebinding);
* strict Content-Security-Policy, no framing, no referrer, small request bodies;
* orders still go through the skills -> risk engine -> journal, exactly like the CLI.
"""

from __future__ import annotations

import dataclasses
import hmac
import json
import re
import secrets
import threading
import time
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from ..indicators import summarize
from ..models import AssetClass
from ..monitor import PriceTracker, ProfitProtectConfig, run_check
from ..pnl import EquityHistory, PnlLedger, realized_trades, summarize as pnl_summary
from ..skills import SkillContext, SkillRegistry, auto_approve, deny_all
from ..skills.equity import KNOWN_ETFS
from ..watchlist import Watchlist, normalize_symbol

STATIC = Path(__file__).parent / "static"
MAX_BODY = 64 * 1024
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class TradingApp:
    """All state and actions behind the HTTP API (kept separate so it is unit-testable)."""

    def __init__(self, ctx: SkillContext, registry: SkillRegistry, *, simulate: bool = False,
                 monitor_interval: int = 300):
        self.ctx = ctx
        self.registry = registry
        self.simulate = simulate
        self.lock = threading.RLock()
        data = ctx.settings.data_dir
        self.watchlist = Watchlist(data / "watchlist.json")
        self.tracker = PriceTracker(data / "price_tracker.json", data / "price_log.jsonl")
        self.ledger = PnlLedger(data / "fills.jsonl")
        self.equity = EquityHistory(data / "equity_history.jsonl")
        self.cfg = ProfitProtectConfig.load()
        self.monitor_interval = monitor_interval
        self.monitor_running = False
        self.last_check: dict[str, Any] = {"at": None, "decisions": []}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_tick = 0.0
        # Orders placed from the UI are confirmed by the user in the UI itself.
        self.order_ctx = dataclasses.replace(ctx, approver=auto_approve)
        # The background monitor may only auto-sell where config allows it.
        live = ctx.settings.is_live
        auto = self.cfg.auto_sell and (not live or self.cfg.auto_sell_live)
        self.monitor_ctx = dataclasses.replace(ctx, approver=auto_approve if auto else deny_all)

    # ------------------------------------------------------------------ state
    def _maybe_tick(self) -> None:
        if self.simulate and hasattr(self.ctx.broker, "tick") and time.time() - self._last_tick > 2:
            self._last_tick = time.time()
            syms = set(self.watchlist.symbols()) | {p.symbol for p in self.ctx.broker.get_positions()
                                                    if p.asset_class != AssetClass.OPTION}
            self.ctx.broker.tick(sorted(syms), minutes=5)

    def state(self) -> dict:
        with self.lock:
            self._maybe_tick()
            broker = self.ctx.broker
            if hasattr(broker, "process_open_orders"):
                broker.process_open_orders()
            account = broker.get_account()
            positions = {p.symbol: p for p in broker.get_positions()}
            decisions = {d["symbol"]: d for d in self.last_check["decisions"]}
            days = self.tracker.state.get("days", {}) if self.tracker.state.get("date") == date.today().isoformat() else {}
            items = []
            for w in self.watchlist.items.values():
                try:
                    q = broker.get_quote(w.symbol)
                    quote = {"bid": q.bid, "ask": q.ask, "last": q.last}
                except Exception as e:
                    quote = {"error": str(e)}
                pos = positions.get(w.symbol)
                day = days.get(w.symbol)
                items.append({
                    "symbol": w.symbol, "labels": w.labels, "monitor": w.monitor, "note": w.note,
                    "etf": w.symbol in KNOWN_ETFS, "quote": quote,
                    "day": day,
                    "position": None if not pos else {
                        "qty": pos.qty, "avg_cost": round(pos.avg_entry_price, 4),
                        "market_value": round(pos.market_value, 2), "unrealized_pl": round(pos.unrealized_pl, 2),
                        "unrealized_pct": round((pos.current_price / pos.avg_entry_price - 1) * 100, 2)
                        if pos.avg_entry_price else None},
                    "protection": decisions.get(w.symbol),
                })
            others = [p.to_dict() for s, p in positions.items() if s not in self.watchlist.items]
            trades = realized_trades(self.ledger.fills()) if self.ledger.path.exists() else []
            pnl = pnl_summary(trades)
            return {
                "mode": self.ctx.settings.trading_mode, "live": self.ctx.settings.is_live,
                "broker": broker.name, "account": account.to_dict(),
                "data_source": getattr(broker, "data_source", "Simulated prices (offline)"),
                "realized": {k: pnl[k] for k in ("realized_net", "realized_profit", "realized_loss", "closed_trades")},
                "watchlist": {"labels": self.watchlist.labels, "items": items},
                "unwatched_positions": others,
                "open_orders": [o.to_dict() for o in broker.list_orders("open")],
                "monitor": {"running": self.monitor_running, "interval": self.monitor_interval,
                            "drop_pct": self.cfg.drop_pct, "reference": self.cfg.reference,
                            "min_profit_pct": self.cfg.min_profit_pct, "enabled": self.cfg.enabled,
                            "auto_sell": self.cfg.auto_sell and (not self.ctx.settings.is_live or self.cfg.auto_sell_live),
                            "last_check": self.last_check["at"]},
                "kill_switch": self.ctx.risk.kill_switch_active(),
            }

    def history(self, symbol: str, days: int = 90) -> dict:
        sym = normalize_symbol(symbol)
        with self.lock:
            closes = self.ctx.broker.get_history(sym, max(20, min(days, 500)))
            q = self.ctx.broker.get_quote(sym)
        return {"symbol": sym, "closes": [round(c, 2) for c in closes], "indicators": summarize(closes),
                "quote": {"bid": q.bid, "ask": q.ask, "last": q.last}}

    # ------------------------------------------------------------------ watchlist
    def add(self, body: dict) -> dict:
        sym = normalize_symbol(body.get("symbol", ""))
        with self.lock:
            try:
                self.ctx.broker.get_quote(sym)
            except Exception as e:
                raise ApiError(400, f"could not get a quote for {sym}: {e}") from e
            item = self.watchlist.add(sym, body.get("labels") or [], bool(body.get("monitor", True)))
            self.ctx.journal.record("watchlist_add", symbol=sym, labels=item.labels)
        return dataclasses.asdict(item)

    def update(self, symbol: str, body: dict) -> dict:
        with self.lock:
            item = self.watchlist.update(symbol, labels=body.get("labels"), monitor=body.get("monitor"),
                                         note=body.get("note"))
        return dataclasses.asdict(item)

    def remove(self, symbol: str) -> dict:
        with self.lock:
            ok = self.watchlist.remove(symbol)
            self.ctx.journal.record("watchlist_remove", symbol=symbol.upper())
        return {"removed": ok}

    def labels(self, method: str, body: dict, name: str | None) -> dict:
        with self.lock:
            if method == "POST":
                self.watchlist.create_label(body.get("name", ""))
            elif method == "PATCH":
                self.watchlist.rename_label(body.get("old", ""), body.get("new", ""))
            elif method == "DELETE" and name:
                self.watchlist.delete_label(name)
            return {"labels": self.watchlist.labels}

    # ------------------------------------------------------------------ orders
    def _order_args(self, body: dict) -> tuple[str, dict]:
        sym = normalize_symbol(body.get("symbol", ""))
        side = body.get("side")
        if side not in ("buy", "sell"):
            raise ApiError(400, "side must be buy or sell")
        kind = "etf" if sym in KNOWN_ETFS else "stock"
        args: dict[str, Any] = {"symbol": sym, "reason": (body.get("reason") or f"web UI {side}")[:200]}
        if body.get("sell_all") and side == "sell":
            args["qty"] = -1
        elif body.get("notional") not in (None, ""):
            args["notional"] = float(body["notional"])
        elif body.get("qty") not in (None, ""):
            args["qty"] = float(body["qty"])
        else:
            raise ApiError(400, "enter a quantity or a dollar amount")
        order_type = body.get("order_type", "market")
        if order_type not in ("market", "limit"):
            raise ApiError(400, "order_type must be market or limit")
        args["order_type"] = order_type
        if order_type == "limit":
            if body.get("limit_price") in (None, ""):
                raise ApiError(400, "limit price required")
            args["limit_price"] = float(body["limit_price"])
        return f"{side}_{kind}", args

    def preview(self, body: dict) -> dict:
        skill, args = self._order_args(body)
        with self.lock:
            return self.registry.get(skill).run(self.order_ctx, **args, dry_run=True)

    def place(self, body: dict) -> dict:
        if body.get("confirm") is not True:
            raise ApiError(400, "order not confirmed")
        if self.ctx.settings.is_live and body.get("confirm_live") is not True:
            raise ApiError(400, "live account: tick 'I understand this uses real money'")
        skill, args = self._order_args(body)
        with self.lock:
            out = self.registry.get(skill).run(self.order_ctx, **args)
            self.ledger.sync(self.ctx.broker)
        return out

    # ------------------------------------------------------------------ label basket
    def _basket_plan(self, body: dict):
        from ..basket import plan_basket

        try:
            amount = float(body.get("amount") or 0)
            discount = float(body.get("discount_pct", 5)) / 100
        except (TypeError, ValueError):
            raise ApiError(400, "amount and discount must be numbers")
        return plan_basket(self.order_ctx, self.watchlist, body.get("label", ""), amount,
                           order_type=body.get("order_type", "market"), discount_pct=discount,
                           time_in_force=body.get("time_in_force", "day"), skip_held=bool(body.get("skip_held")))

    def basket_preview(self, body: dict) -> dict:
        from ..basket import run_basket

        with self.lock:
            return run_basket(self.order_ctx, self.registry, self._basket_plan(body), dry_run=True).to_dict()

    def basket_place(self, body: dict) -> dict:
        from ..basket import BasketError, run_basket

        if body.get("confirm") is not True:
            raise ApiError(400, "basket not confirmed")
        if self.ctx.settings.is_live and body.get("confirm_live") is not True:
            raise ApiError(400, "live account: tick 'I understand this uses real money'")
        with self.lock:
            try:
                plan = run_basket(self.order_ctx, self.registry, self._basket_plan(body), dry_run=False)
            except BasketError as e:
                raise ApiError(400, str(e)) from e
            self.ledger.sync(self.ctx.broker)
        return plan.to_dict()

    def cancel(self, order_id: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9\-]{6,64}", order_id):
            raise ApiError(400, "bad order id")
        with self.lock:
            self.ctx.broker.cancel_order(order_id)
            self.ctx.journal.record("canceled", order_id=order_id, source="web UI")
        return {"canceled": order_id}

    # ------------------------------------------------------------------ monitor
    def run_monitor(self, dry_run: bool = False) -> dict:
        with self.lock:
            decisions = run_check(self.monitor_ctx, self.cfg, self.tracker, execute=not dry_run,
                                  watchlist=self.watchlist)
            self.equity.snapshot(self.ctx.broker)
            self.ledger.sync(self.ctx.broker)
            self.last_check = {"at": time.strftime("%Y-%m-%d %H:%M:%S"),
                               "decisions": [d.to_dict() for d in decisions], "dry_run": dry_run}
        return self.last_check

    def set_monitor(self, running: bool) -> dict:
        if running and not self.monitor_running:
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="profit-monitor", daemon=True)
            self.monitor_running = True
            self._thread.start()
        elif not running and self.monitor_running:
            self._stop.set()
            self.monitor_running = False
        self.ctx.journal.record("monitor_toggled", running=running, source="web UI")
        return {"running": self.monitor_running}

    def _loop(self) -> None:
        from ..monitor import market_open

        while not self._stop.is_set():
            try:
                if not self.cfg.respect_market_hours or market_open(self.ctx.broker) or self.simulate:
                    self.run_monitor()
            except Exception as e:  # keep running; surface in the journal
                self.ctx.journal.record("monitor_error", error=str(e), source="web UI")
            self._stop.wait(self.monitor_interval)

    def stop(self) -> None:
        self._stop.set()


class Handler(BaseHTTPRequestHandler):
    app: TradingApp
    token: str
    port: int
    server_version = "trading-agent-ui"

    def log_message(self, fmt, *args):  # quiet; never log tokens
        pass

    # ---------------------------------------------------------------- plumbing
    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj: Any) -> None:
        self._send(status, json.dumps(obj, default=str).encode(), "application/json")

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}")

    def _authorized(self) -> bool:
        return hmac.compare_digest(self.headers.get("X-Auth-Token", ""), self.token)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "request too large")
        if not length:
            return {}
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            raise ApiError(415, "JSON required")
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ApiError(400, "JSON object required")
        return data

    # ---------------------------------------------------------------- routing
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        if not self._host_ok():
            return self._json(403, {"error": "bad host"})
        url = urlparse(self.path)
        path = url.path
        if method == "GET" and path in ("/", "/index.html", "/app.js", "/app.css"):
            name = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
            ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                     "css": "text/css; charset=utf-8"}[name.rsplit(".", 1)[1]]
            return self._send(200, (STATIC / name).read_bytes(), ctype)
        if not path.startswith("/api/"):
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(401, {"error": "missing or wrong token - open the URL printed by `ui`"})
        try:
            body = self._body() if method in ("POST", "PATCH", "DELETE") else {}
            result = self._route(method, path, parse_qs(url.query), body)
            self._json(200, result)
        except ApiError as e:
            self._json(e.status, {"error": str(e)})
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e).strip("'\"")})
        except Exception as e:  # broker/network errors
            self._json(502, {"error": f"{type(e).__name__}: {e}"})

    def _route(self, method: str, path: str, query: dict, body: dict) -> Any:
        app = self.app
        parts = [unquote(p) for p in path.split("/")[2:]]   # after /api/
        match (method, parts):
            case ("GET", ["state"]):
                return app.state()
            case ("GET", ["history", sym]):
                return app.history(sym, int(query.get("days", ["90"])[0]))
            case ("POST", ["watchlist"]):
                return app.add(body)
            case ("PATCH", ["watchlist", sym]):
                return app.update(sym, body)
            case ("DELETE", ["watchlist", sym]):
                return app.remove(sym)
            case ("POST" | "PATCH", ["labels"]):
                return app.labels(method, body, None)
            case ("DELETE", ["labels", name]):
                return app.labels(method, body, name)
            case ("POST", ["order", "preview"]):
                return app.preview(body)
            case ("POST", ["basket", "preview"]):
                return app.basket_preview(body)
            case ("POST", ["basket"]):
                return app.basket_place(body)
            case ("POST", ["order"]):
                return app.place(body)
            case ("POST", ["orders", oid, "cancel"]):
                return app.cancel(oid)
            case ("POST", ["monitor", "run"]):
                return app.run_monitor(dry_run=bool(body.get("dry_run")))
            case ("POST", ["monitor", "toggle"]):
                return app.set_monitor(bool(body.get("running")))
        raise ApiError(404, "unknown endpoint")


def make_server(app: TradingApp, port: int = 8765) -> tuple[ThreadingHTTPServer, str]:
    token = secrets.token_urlsafe(24)
    handler = type("BoundHandler", (Handler,), {"app": app, "token": token, "port": port})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    if port == 0:  # tests: pick a free port
        handler.port = server.server_address[1]
    return server, token


__all__ = ["TradingApp", "make_server", "ApiError"]
