"""Watchlist + web UI API tests (real HTTP server on a random localhost port)."""

import http.client
import json
import threading

import pytest

from trading_agent.models import AssetClass, Order, Side
from trading_agent.monitor import PriceTracker, ProfitProtectConfig, run_check
from trading_agent.watchlist import Watchlist
from trading_agent.webui.server import TradingApp, make_server


# ------------------------------------------------------------------ watchlist model
def test_watchlist_labels_group_filter(tmp_path):
    wl = Watchlist(tmp_path / "w.json")
    wl.add("nvda", ["Tech", "AI"])
    wl.add("JPM", ["Dividend"])
    wl.add("XOM", ["Dividend", "Energy"], monitor=False)
    wl.add("TSLA")
    assert wl.grouped() == {"Tech": ["NVDA"], "AI": ["NVDA"], "Dividend": ["JPM", "XOM"],
                            "Energy": ["XOM"], "Unlabeled": ["TSLA"]}
    assert [i.symbol for i in wl.filter(["Dividend"])] == ["JPM", "XOM"]
    assert [i.symbol for i in wl.filter(["Dividend", "Energy"], match="all")] == ["XOM"]
    assert wl.monitored() == {"NVDA", "JPM", "TSLA"}
    wl.rename_label("Dividend", "Income")
    wl.delete_label("AI")
    wl2 = Watchlist(tmp_path / "w.json")  # persisted
    assert wl2.items["JPM"].labels == ["Income"] and wl2.items["NVDA"].labels == ["Tech"]
    assert "AI" not in wl2.labels and wl2.remove("TSLA") and "TSLA" not in Watchlist(tmp_path / "w.json").items


@pytest.mark.parametrize("bad", ["", "AAPL;rm", "<script>", "TOOLONGTICKER1"])
def test_watchlist_rejects_bad_symbols(tmp_path, bad):
    with pytest.raises(ValueError):
        Watchlist(tmp_path / "w.json").add(bad)


def test_watchlist_rejects_bad_labels(tmp_path):
    with pytest.raises(ValueError):
        Watchlist(tmp_path / "w.json").add("AAPL", ["<img src=x>"])


def test_monitor_respects_watchlist(ctx, broker, tmp_path):
    broker.submit_order(Order("NVDA", 10, Side.BUY, AssetClass.STOCK))
    broker.submit_order(Order("JPM", 10, Side.BUY, AssetClass.STOCK))
    wl = Watchlist(tmp_path / "w.json")
    wl.add("NVDA", monitor=False)
    wl.add("JPM")
    wl.add("MSFT")  # watched only
    cfg = ProfitProtectConfig()
    tracker = PriceTracker(tmp_path / "t.json", tmp_path / "l.jsonl")
    for sym in ("NVDA", "JPM"):
        broker.market._prices[sym] = broker.get_position(sym).avg_entry_price * 1.10
    run_check(ctx, cfg, tracker, today="2026-10-01", watchlist=wl)
    for sym in ("NVDA", "JPM"):
        broker.market._prices[sym] = broker.get_position(sym).avg_entry_price * 1.05
    d = {x.symbol: x for x in run_check(ctx, cfg, tracker, today="2026-10-01", watchlist=wl)}
    assert d["NVDA"].action == "skip" and broker.get_position("NVDA") is not None   # unticked: untouched
    assert d["JPM"].action == "sell_now" and broker.get_position("JPM") is None      # ticked: protected
    assert d["MSFT"].action == "watch" and "MSFT" in tracker.state["days"]


# ------------------------------------------------------------------ HTTP API
@pytest.fixture
def server(ctx, registry):
    app = TradingApp(ctx, registry)
    srv, token = make_server(app, 0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield app, port, token
    app.stop()
    srv.shutdown()
    srv.server_close()


def call(port, method, path, body=None, token=None, host=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Host": host or f"127.0.0.1:{port}"}
    if token:
        headers["X-Auth-Token"] = token
    data = None
    if body is not None:
        data = json.dumps(body)
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    r = conn.getresponse()
    raw = r.read()
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = raw.decode()
    return r.status, payload, dict(r.getheaders())


def test_static_page_and_security_headers(server):
    _, port, _ = server
    status, body, headers = call(port, "GET", "/")
    assert status == 200 and "Watchlist" in body
    assert "script-src 'self'" in headers["Content-Security-Policy"] and headers["X-Frame-Options"] == "DENY"
    assert call(port, "GET", "/app.js")[0] == 200 and call(port, "GET", "/../config/risk.toml")[0] == 404


def test_api_requires_token_and_local_host(server):
    _, port, token = server
    assert call(port, "GET", "/api/state")[0] == 401
    assert call(port, "GET", "/api/state", token="wrong")[0] == 401
    assert call(port, "GET", "/api/state", token=token, host="evil.example:80")[0] == 403
    assert call(port, "GET", "/api/state", token=token)[0] == 200


def test_watchlist_crud_over_http(server):
    _, port, token = server
    s, b, _ = call(port, "POST", "/api/watchlist", {"symbol": "nvda", "labels": ["Tech", "AI"]}, token)
    assert s == 200 and b["symbol"] == "NVDA"
    call(port, "POST", "/api/watchlist", {"symbol": "JPM", "labels": ["Dividend"]}, token)
    call(port, "PATCH", "/api/watchlist/JPM", {"labels": ["Dividend", "Financials"], "monitor": False}, token)
    call(port, "PATCH", "/api/labels", {"old": "AI", "new": "Artificial Intelligence"}, token)
    call(port, "DELETE", "/api/labels/Financials", None, token)
    state = call(port, "GET", "/api/state", token=token)[1]
    items = {i["symbol"]: i for i in state["watchlist"]["items"]}
    assert items["NVDA"]["labels"] == ["Artificial Intelligence", "Tech"]
    assert items["JPM"]["labels"] == ["Dividend"] and items["JPM"]["monitor"] is False
    assert call(port, "DELETE", "/api/watchlist/NVDA", None, token)[1] == {"removed": True}
    assert call(port, "POST", "/api/watchlist", {"symbol": "BAD;"}, token)[0] == 400


def test_click_to_buy_preview_then_confirm(server, broker):
    _, port, token = server
    order = {"symbol": "MSFT", "side": "buy", "qty": "5", "order_type": "market"}
    s, prev, _ = call(port, "POST", "/api/order/preview", order, token)
    assert s == 200 and prev["status"] == "preview_only" and prev["risk"]["approved"]
    assert broker.get_position("MSFT") is None
    assert call(port, "POST", "/api/order", order, token)[0] == 400           # not confirmed
    s, res, _ = call(port, "POST", "/api/order", {**order, "confirm": True}, token)
    assert s == 200 and res["status"] == "filled" and broker.get_position("MSFT").qty == 5
    s, res, _ = call(port, "POST", "/api/order", {"symbol": "MSFT", "side": "sell", "sell_all": True,
                                                   "order_type": "market", "confirm": True}, token)
    assert res["status"] == "filled" and broker.get_position("MSFT") is None


def test_risk_engine_still_applies(server):
    _, port, token = server
    s, res, _ = call(port, "POST", "/api/order", {"symbol": "AAPL", "side": "buy", "qty": 10000,
                                                   "order_type": "market", "confirm": True}, token)
    assert s == 200 and res["status"] == "rejected_by_risk"


def test_live_orders_need_extra_ack(server, ctx):
    _, port, token = server
    ctx.settings.trading_mode = "alpaca-live"
    order = {"symbol": "SPY", "side": "buy", "qty": 1, "order_type": "market", "confirm": True}
    s, res, _ = call(port, "POST", "/api/order", order, token)
    assert s == 400 and "real money" in res["error"]


def test_monitor_endpoints(server):
    _, port, token = server
    call(port, "POST", "/api/watchlist", {"symbol": "SPY"}, token)
    s, res, _ = call(port, "POST", "/api/monitor/run", {"dry_run": True}, token)
    assert s == 200 and res["dry_run"] and res["decisions"][0]["action"] == "watch"
    assert call(port, "POST", "/api/monitor/toggle", {"running": True}, token)[1] == {"running": True}
    assert call(port, "POST", "/api/monitor/toggle", {"running": False}, token)[1] == {"running": False}


def test_body_must_be_json(server):
    _, port, token = server
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("POST", "/api/watchlist", body="symbol=AAPL",
                 headers={"Host": f"127.0.0.1:{port}", "X-Auth-Token": token,
                          "Content-Type": "application/x-www-form-urlencoded"})
    assert conn.getresponse().status == 415
