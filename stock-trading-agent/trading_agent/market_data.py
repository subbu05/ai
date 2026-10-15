"""Live market data for the paper broker, watchlist, monitor and UI.

Providers (choose with MARKET_DATA, or [market_data] provider in the accounts file):

| name        | key needed              | quotes                                   | history        |
|-------------|-------------------------|------------------------------------------|----------------|
| simulated   | no                      | offline random walk (default)            | simulated      |
| yahoo       | no                      | Yahoo Finance chart API (unofficial; may | yes            |
|             |                         | be delayed; personal use)                |                |
| finnhub     | FINNHUB_API_KEY (free)  | real-time US quotes, ~60 calls/min free  | via yahoo      |
| alpaca      | Alpaca keys (free acct) | IEX real-time bid/ask (free "Basic" plan)| yes (IEX bars) |

A comma list sets a fallback chain, e.g. ``MARKET_DATA=finnhub,yahoo``. Every provider is
wrapped in a cache (quotes 15 s, history 1 h by default) so a watchlist that refreshes every
few seconds doesn't hit rate limits. When a source fails or is rate-limited, the last good
price is served (flagged stale) or the next provider in the chain is tried.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

from .models import Quote

Fetcher = Callable[[str, dict], dict]
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"


class MarketDataError(RuntimeError):
    pass


def http_get_json(url: str, headers: dict | None = None, timeout: float = 10.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise MarketDataError("rate limited (HTTP 429)") from e
        raise MarketDataError(f"HTTP {e.code} from {urllib.parse.urlsplit(url).netloc}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise MarketDataError(f"cannot reach {urllib.parse.urlsplit(url).netloc}: {e}") from e
    except json.JSONDecodeError as e:
        raise MarketDataError("bad JSON from market data provider") from e


class Provider:
    name = "base"
    description = ""

    def quote(self, symbol: str) -> Quote:
        raise NotImplementedError

    def history(self, symbol: str, days: int) -> list[float]:
        raise MarketDataError(f"{self.name} has no price history")


class SimulatedProvider(Provider):
    name = "simulated"
    description = "Simulated prices (offline)"

    def __init__(self, market):
        self.market = market

    def quote(self, symbol: str) -> Quote:
        return self.market.quote(symbol)

    def history(self, symbol: str, days: int) -> list[float]:
        return self.market.history(symbol, days)


class YahooProvider(Provider):
    """Yahoo Finance chart endpoint. No key; unofficial, can change, may be delayed."""

    name = "yahoo"
    description = "Yahoo Finance (unofficial, may be delayed)"
    BASE = "https://query1.finance.yahoo.com/v8/finance/chart/"

    def __init__(self, fetch: Fetcher | None = None):
        self.fetch = fetch or (lambda url, h: http_get_json(url, h))

    def _chart(self, symbol: str, rng: str, interval: str = "1d") -> dict:
        url = f"{self.BASE}{urllib.parse.quote(symbol.upper())}?range={rng}&interval={interval}&includePrePost=false"
        data = self.fetch(url, {})
        chart = data.get("chart") or {}
        if chart.get("error"):
            raise MarketDataError(f"yahoo: {chart['error'].get('description') or chart['error']}")
        result = (chart.get("result") or [None])[0]
        if not result:
            raise MarketDataError(f"yahoo: no data for {symbol}")
        return result

    def quote(self, symbol: str) -> Quote:
        meta = self._chart(symbol, "1d", "1m").get("meta", {})
        price = meta.get("regularMarketPrice")
        if price is None:
            raise MarketDataError(f"yahoo: no price for {symbol}")
        price = float(price)
        return Quote(symbol.upper(), price, price, price)  # chart API has no bid/ask

    def history(self, symbol: str, days: int) -> list[float]:
        rng = "1mo" if days <= 20 else "3mo" if days <= 60 else "6mo" if days <= 120 else "1y" if days <= 250 else "2y"
        result = self._chart(symbol, rng, "1d")
        quotes = ((result.get("indicators") or {}).get("quote") or [{}])[0]
        closes = [float(c) for c in (quotes.get("close") or []) if c is not None]
        if not closes:
            raise MarketDataError(f"yahoo: no history for {symbol}")
        return closes[-days:]


class FinnhubProvider(Provider):
    """finnhub.io /quote: c=current, h=high, l=low, o=open, pc=previous close, t=time."""

    name = "finnhub"
    description = "Finnhub (real-time US quotes)"
    BASE = "https://finnhub.io/api/v1/quote"

    def __init__(self, api_key: str, fetch: Fetcher | None = None):
        if not api_key:
            raise MarketDataError("finnhub needs FINNHUB_API_KEY (free at finnhub.io)")
        self.api_key = api_key
        self.fetch = fetch or (lambda url, h: http_get_json(url, h))

    def quote(self, symbol: str) -> Quote:
        sym = symbol.upper()
        data = self.fetch(f"{self.BASE}?symbol={urllib.parse.quote(sym)}", {"X-Finnhub-Token": self.api_key})
        price = data.get("c")
        if not price:  # finnhub returns c=0 for unknown symbols
            raise MarketDataError(f"finnhub: no quote for {sym}")
        price = float(price)
        return Quote(sym, price, price, price)


class AlpacaDataProvider(Provider):
    """Alpaca market data (free Basic plan = IEX real-time)."""

    name = "alpaca"
    description = "Alpaca market data (IEX real-time)"
    BASE = "https://data.alpaca.markets/v2/stocks"

    def __init__(self, key_id: str, secret: str, feed: str = "iex", fetch: Fetcher | None = None):
        if not key_id or not secret:
            raise MarketDataError("alpaca market data needs ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY")
        self.headers = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
        self.feed = feed
        self.fetch = fetch or (lambda url, h: http_get_json(url, h))

    def quote(self, symbol: str) -> Quote:
        sym = symbol.upper()
        data = self.fetch(f"{self.BASE}/{urllib.parse.quote(sym)}/snapshot?feed={self.feed}", self.headers)
        q, t = data.get("latestQuote") or {}, data.get("latestTrade") or {}
        last = float(t.get("p") or 0)
        bid, ask = float(q.get("bp") or 0), float(q.get("ap") or 0)
        if not last and not (bid and ask):
            raise MarketDataError(f"alpaca: no quote for {sym}")
        return Quote(sym, bid or last, ask or last, last or round((bid + ask) / 2, 4))

    def history(self, symbol: str, days: int) -> list[float]:
        start = time.strftime("%Y-%m-%d", time.gmtime(time.time() - (days * 1.6 + 7) * 86400))
        data = self.fetch(f"{self.BASE}/{urllib.parse.quote(symbol.upper())}/bars?timeframe=1Day&start={start}"
                          f"&limit=10000&adjustment=all&feed={self.feed}", self.headers)
        closes = [float(b["c"]) for b in (data.get("bars") or [])]
        if not closes:
            raise MarketDataError(f"alpaca: no history for {symbol}")
        return closes[-days:]


class CachedChain(Provider):
    """Fallback chain + TTL cache + per-provider rate limit. Thread-safe."""

    def __init__(self, providers: list[Provider], quote_ttl: float = 15.0, history_ttl: float = 3600.0,
                 max_calls_per_min: dict[str, int] | None = None, clock: Callable[[], float] = time.time):
        if not providers:
            raise ValueError("at least one provider required")
        self.providers = providers
        self.quote_ttl, self.history_ttl = quote_ttl, history_ttl
        self.limits = {"finnhub": 55, "yahoo": 120, "alpaca": 180, **(max_calls_per_min or {})}
        self.clock = clock
        self._quotes: dict[str, tuple[float, Quote, str]] = {}
        self._hist: dict[tuple[str, int], tuple[float, list[float]]] = {}
        self._calls: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self.last_source: dict[str, str] = {}
        self.name = ",".join(p.name for p in providers)
        self.description = " → ".join(p.description for p in providers)

    def _allow(self, provider: Provider) -> bool:
        limit = self.limits.get(provider.name)
        if not limit:
            return True
        now = self.clock()
        calls = [t for t in self._calls.get(provider.name, []) if now - t < 60]
        if len(calls) >= limit:
            self._calls[provider.name] = calls
            return False
        calls.append(now)
        self._calls[provider.name] = calls
        return True

    def quote(self, symbol: str) -> Quote:
        sym = symbol.upper()
        now = self.clock()
        with self._lock:
            hit = self._quotes.get(sym)
            if hit and now - hit[0] < self.quote_ttl:
                return hit[1]
        errors = []
        for p in self.providers:
            with self._lock:
                if not self._allow(p):
                    errors.append(f"{p.name}: local rate limit")
                    continue
            try:
                q = p.quote(sym)
            except MarketDataError as e:
                errors.append(str(e))
                continue
            with self._lock:
                self._quotes[sym] = (self.clock(), q, p.name)
                self.last_source[sym] = p.name
            return q
        with self._lock:
            if hit:  # serve the last good price rather than failing
                self.last_source[sym] = f"{hit[2]} (stale)"
                return hit[1]
        raise MarketDataError(f"no price for {sym}: " + "; ".join(errors))

    def history(self, symbol: str, days: int) -> list[float]:
        key = (symbol.upper(), days)
        now = self.clock()
        with self._lock:
            hit = self._hist.get(key)
            if hit and now - hit[0] < self.history_ttl:
                return hit[1]
        errors = []
        candidates = self.providers + ([YahooProvider()] if not any(isinstance(p, (YahooProvider, SimulatedProvider))
                                                                     for p in self.providers) else [])
        for p in candidates:
            try:
                closes = p.history(symbol, days)
            except MarketDataError as e:
                errors.append(str(e))
                continue
            with self._lock:
                self._hist[key] = (self.clock(), closes)
            return closes
        if hit:
            return hit[1]
        raise MarketDataError(f"no history for {symbol}: " + "; ".join(errors))


def build_provider(spec: str | None = None, market=None) -> Provider:
    """Build the configured chain. ``market`` is the paper broker's SimulatedMarket."""
    spec = (spec if spec is not None else os.getenv("MARKET_DATA", "simulated")).strip().lower() or "simulated"
    providers: list[Provider] = []
    for name in [s.strip() for s in spec.split(",") if s.strip()]:
        if name == "simulated":
            if market is None:
                from .brokers.paper import SimulatedMarket
                market = SimulatedMarket()
            providers.append(SimulatedProvider(market))
        elif name == "yahoo":
            providers.append(YahooProvider())
        elif name == "finnhub":
            providers.append(FinnhubProvider(os.getenv("FINNHUB_API_KEY", "")))
        elif name == "alpaca":
            providers.append(AlpacaDataProvider(os.getenv("ALPACA_API_KEY_ID", ""),
                                                os.getenv("ALPACA_API_SECRET_KEY", ""),
                                                os.getenv("ALPACA_DATA_FEED", "iex")))
        else:
            raise ValueError(f"unknown market data provider {name!r} (simulated, yahoo, finnhub, alpaca)")
    if len(providers) == 1 and isinstance(providers[0], SimulatedProvider):
        return providers[0]
    ttl = float(os.getenv("MARKET_DATA_TTL", "15"))
    return CachedChain(providers, quote_ttl=ttl)
