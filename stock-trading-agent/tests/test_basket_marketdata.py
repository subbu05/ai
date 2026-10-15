"""Label basket buying and live market data providers (HTTP faked; no network)."""

import pytest

from trading_agent.basket import BasketError, plan_basket, run_basket
from trading_agent.brokers import PaperBroker
from trading_agent.market_data import (AlpacaDataProvider, CachedChain, FinnhubProvider, MarketDataError,
                                       YahooProvider, build_provider)
from trading_agent.models import AssetClass, Order, OrderType, Quote, Side
from trading_agent.watchlist import Watchlist


@pytest.fixture
def wl(tmp_path):
    w = Watchlist(tmp_path / "w.json")
    for s in ("AAPL", "MSFT", "NVDA", "QQQ"):
        w.add(s, ["Tech"])
    w.add("JPM", ["Dividend"])
    return w


# ------------------------------------------------------------------ basket
def test_market_basket_equal_split(ctx, registry, wl):
    plan = plan_basket(ctx, wl, "Tech", 20_000)
    assert plan.per_ticker == 5000 and [l.symbol for l in plan.legs] == ["AAPL", "MSFT", "NVDA", "QQQ"]
    for leg in plan.legs:
        assert leg.qty == int(5000 // leg.order_price) and leg.est_cost <= 5000
    done = run_basket(ctx, registry, plan, dry_run=False)
    assert all(l.status == "filled" for l in done.legs)
    assert {p.symbol for p in ctx.broker.get_positions()} == {"AAPL", "MSFT", "NVDA", "QQQ"}
    assert ctx.broker.get_position("QQQ").asset_class == AssetClass.ETF


def test_limit_basket_five_percent_below(ctx, registry, wl, broker):
    plan = plan_basket(ctx, wl, "Tech", 20_000, order_type="limit")
    for leg in plan.legs:
        assert leg.limit_price == round(leg.market_price * 0.95, 2)
        assert leg.qty == int(5000 // leg.limit_price)
    run_basket(ctx, registry, plan, dry_run=False)
    orders = broker.list_orders("open")
    assert len(orders) == 4 and all(o.order_type == OrderType.LIMIT for o in orders)
    assert broker.get_positions() == []                   # nothing fills until the price drops 5%
    nvda = next(o for o in orders if o.symbol == "NVDA")
    broker.market._prices["NVDA"] = nvda.limit_price * 0.99
    broker.process_open_orders()
    assert broker.get_position("NVDA").qty == nvda.qty


def test_custom_discount_and_gtc(ctx, wl):
    plan = plan_basket(ctx, wl, "Tech", 10_000, order_type="limit", discount_pct=0.10, time_in_force="gtc")
    assert all(l.limit_price == round(l.market_price * 0.90, 2) for l in plan.legs)
    assert plan.time_in_force == "gtc"


def test_skip_held_and_tiny_amounts(ctx, wl, broker):
    broker.submit_order(Order("AAPL", 1, Side.BUY, AssetClass.STOCK))
    plan = plan_basket(ctx, wl, "Tech", 400, skip_held=True)
    by = {l.symbol: l for l in plan.legs}
    assert by["AAPL"].status == "skipped" and by["AAPL"].note == "already held"
    assert plan.per_ticker == pytest.approx(133.33)
    assert by["MSFT"].status == "skipped" and "less than one share" in by["MSFT"].note   # MSFT ~ $420
    assert by["NVDA"].qty == 1


def test_basket_validation(ctx, wl):
    with pytest.raises(ValueError, match="no tickers"):
        plan_basket(ctx, wl, "Nope", 1000)
    with pytest.raises(ValueError):
        plan_basket(ctx, wl, "Tech", -5)
    with pytest.raises(ValueError):
        plan_basket(ctx, wl, "Tech", 1000, order_type="limit", discount_pct=0.9)


def test_basket_over_buying_power_blocked(ctx, registry, wl):
    ctx.risk.limits.max_order_notional = 1e9
    ctx.risk.limits.max_position_pct = ctx.risk.limits.max_etf_position_pct = 10
    plan = plan_basket(ctx, wl, "Tech", 400_000)
    preview = run_basket(ctx, registry, plan, dry_run=True)
    assert any("buying power" in w for w in preview.warnings)
    with pytest.raises(BasketError):
        run_basket(ctx, registry, plan_basket(ctx, wl, "Tech", 400_000), dry_run=False)
    assert ctx.broker.get_positions() == []


def test_open_buy_orders_reserve_buying_power(broker):
    bp = broker.get_account().buying_power
    broker.submit_order(Order("SPY", 10, Side.BUY, AssetClass.ETF, OrderType.LIMIT, limit_price=100))
    assert broker.get_account().buying_power == pytest.approx(bp - 1000)


def test_basket_risk_rejects_individual_legs(ctx, registry, wl):
    ctx.risk.limits.blocked_symbols = ["NVDA"]
    done = run_basket(ctx, registry, plan_basket(ctx, wl, "Tech", 8000), dry_run=False)
    by = {l.symbol: l for l in done.legs}
    assert by["NVDA"].status == "rejected_by_risk" and "blocked" in by["NVDA"].note
    assert by["AAPL"].status == "filled"


def test_basket_skill(registry, ctx, tmp_path):
    Watchlist(ctx.settings.data_dir / "watchlist.json").add("SPY", ["Index"])
    out = registry.get("buy_label_basket").run(ctx, label="Index", amount=2000, order_type="limit")
    assert out["legs"][0]["status"] == "preview_only" and out["discount_pct"] == 0.05
    assert registry.get("buy_label_basket").run(ctx, label="Missing", amount=10)["status"] == "invalid"


# ------------------------------------------------------------------ market data
YAHOO_QUOTE = {"chart": {"result": [{"meta": {"regularMarketPrice": 231.5, "currency": "USD"},
                                       "indicators": {"quote": [{"close": [229.0, None, 231.5]}]}}], "error": None}}


def test_yahoo_quote_and_history():
    urls = []
    y = YahooProvider(fetch=lambda url, h: urls.append(url) or YAHOO_QUOTE)
    q = y.quote("aapl")
    assert (q.symbol, q.last, q.bid, q.ask) == ("AAPL", 231.5, 231.5, 231.5)
    assert y.history("AAPL", 60) == [229.0, 231.5]           # nulls dropped
    assert "v8/finance/chart/AAPL" in urls[0] and "range=3mo" in urls[1]


def test_yahoo_errors():
    with pytest.raises(MarketDataError, match="No data"):
        YahooProvider(fetch=lambda u, h: {"chart": {"result": None, "error": {"description": "No data found"}}}).quote("ZZZZ")


def test_finnhub_quote_uses_header_token():
    seen = {}
    f = FinnhubProvider("KEY123", fetch=lambda url, h: seen.update(url=url, h=h) or {"c": 101.25, "pc": 100})
    assert f.quote("msft").last == 101.25
    assert seen["h"] == {"X-Finnhub-Token": "KEY123"} and "KEY123" not in seen["url"]   # key never in URLs/logs
    with pytest.raises(MarketDataError):
        FinnhubProvider("K", fetch=lambda u, h: {"c": 0}).quote("NOPE")
    with pytest.raises(MarketDataError):
        FinnhubProvider("")


def test_alpaca_snapshot_and_bars():
    def fetch(url, h):
        assert h["APCA-API-KEY-ID"] == "id" and "feed=iex" in url
        if "snapshot" in url:
            return {"latestQuote": {"bp": 99.9, "ap": 100.1}, "latestTrade": {"p": 100.0}}
        return {"bars": [{"c": 98.0}, {"c": 100.0}]}
    a = AlpacaDataProvider("id", "secret", fetch=fetch)
    q = a.quote("SPY")
    assert (q.bid, q.ask, q.last) == (99.9, 100.1, 100.0)
    assert a.history("SPY", 30) == [98.0, 100.0]


class FakeProvider:
    def __init__(self, name, price=None, fail=False):
        self.name, self.description, self.price, self.fail, self.calls = name, name, price, fail, 0

    def quote(self, symbol):
        self.calls += 1
        if self.fail:
            raise MarketDataError(f"{self.name} down")
        return Quote(symbol, self.price, self.price, self.price)

    def history(self, symbol, days):
        raise MarketDataError("none")


def test_chain_cache_fallback_and_stale():
    now = [1000.0]
    a, b = FakeProvider("finnhub", fail=True), FakeProvider("yahoo", price=50)
    chain = CachedChain([a, b], quote_ttl=15, clock=lambda: now[0])
    assert chain.quote("X").last == 50 and chain.last_source["X"] == "yahoo"
    chain.quote("X")
    assert b.calls == 1                                   # cached
    now[0] += 20
    b.fail = True
    assert chain.quote("X").last == 50 and chain.last_source["X"] == "yahoo (stale)"
    with pytest.raises(MarketDataError):
        chain.quote("NEVERSEEN")


def test_chain_rate_limit():
    p = FakeProvider("finnhub", price=10)
    chain = CachedChain([p], quote_ttl=0, max_calls_per_min={"finnhub": 3}, clock=lambda: 0.0)
    for _ in range(3):
        chain.quote("A")
    assert chain.quote("A").last == 10 and p.calls == 3   # 4th call served from the last good price


def test_build_provider_and_paper_broker_uses_it(monkeypatch):
    assert build_provider("simulated").name == "simulated"
    with pytest.raises(ValueError):
        build_provider("bloomberg")
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    with pytest.raises(MarketDataError):
        build_provider("finnhub")
    chain = CachedChain([FakeProvider("yahoo", price=123.45)])
    b = PaperBroker(10_000, data=chain)
    assert b.get_quote("AAPL").last == 123.45
    o = b.submit_order(Order("AAPL", 2, Side.BUY, AssetClass.STOCK))
    assert o.filled_avg_price == 123.45 and b.data_source == "yahoo"
