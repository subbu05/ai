"""Alpaca REST adapter (stocks, ETFs and options).

Uses only the standard library. Paper endpoint by default; the live endpoint
is used only when TRADING_MODE=alpaca-live. API reference:
https://docs.alpaca.markets/reference
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from ..models import (
    Account,
    AssetClass,
    Fill,
    OptionContract,
    Order,
    OrderStatus,
    OrderType,
    Position,
    Quote,
    Side,
    TimeInForce,
)
from .base import Broker, BrokerError

PAPER_URL = "https://paper-api.alpaca.markets"
LIVE_URL = "https://api.alpaca.markets"
DATA_URL = "https://data.alpaca.markets"

_STATUS = {
    "new": OrderStatus.NEW, "accepted": OrderStatus.NEW, "pending_new": OrderStatus.NEW,
    "partially_filled": OrderStatus.PARTIALLY_FILLED, "filled": OrderStatus.FILLED,
    "canceled": OrderStatus.CANCELED, "expired": OrderStatus.CANCELED,
    "rejected": OrderStatus.REJECTED,
}


def _is_occ(symbol: str) -> bool:
    return len(symbol) >= 16 and symbol[-9] in "CP" and symbol[-8:].isdigit()


class AlpacaBroker(Broker):
    name = "alpaca"

    def __init__(self, key_id: str, secret_key: str, live: bool = False, timeout: float = 15.0):
        if not key_id or not secret_key:
            raise BrokerError("ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY must be set")
        self.base_url = LIVE_URL if live else PAPER_URL
        self.live = live
        self.timeout = timeout
        self._headers = {
            "APCA-API-KEY-ID": key_id,
            "APCA-API-SECRET-KEY": secret_key,
            "Content-Type": "application/json",
        }
        self._etf_cache: dict[str, bool] = {}

    # ------------------------------------------------------------------ http
    def _request(self, method: str, url: str, params: dict | None = None, body: dict | None = None):
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self._headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise BrokerError(f"Alpaca {method} {url} -> {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise BrokerError(f"Alpaca connection error: {e.reason}") from e

    def _trading(self, method: str, path: str, **kw):
        return self._request(method, f"{self.base_url}{path}", **kw)

    def _data(self, path: str, **kw):
        return self._request("GET", f"{DATA_URL}{path}", **kw)

    # --------------------------------------------------------------- account
    def get_account(self) -> Account:
        a = self._trading("GET", "/v2/account")
        return Account(
            cash=float(a["cash"]),
            equity=float(a["equity"]),
            buying_power=float(a.get("options_buying_power") or a["buying_power"]),
            day_start_equity=float(a.get("last_equity") or a["equity"]),
            options_level=int(a.get("options_trading_level") or 0),
        )

    def get_positions(self) -> list[Position]:
        out = []
        for p in self._trading("GET", "/v2/positions"):
            cls = p.get("asset_class", "us_equity")
            asset = AssetClass.OPTION if cls == "us_option" else (
                AssetClass.ETF if self._is_etf(p["symbol"]) else AssetClass.STOCK)
            out.append(Position(
                symbol=p["symbol"],
                qty=float(p["qty"]),
                avg_entry_price=float(p["avg_entry_price"]),
                asset_class=asset,
                current_price=float(p.get("current_price") or 0),
            ))
        return out

    def _is_etf(self, symbol: str) -> bool:
        if symbol not in self._etf_cache:
            try:
                asset = self._trading("GET", f"/v2/assets/{urllib.parse.quote(symbol)}")
                name = (asset.get("name") or "").upper()
                self._etf_cache[symbol] = any(t in name for t in (" ETF", "TRUST", " FUND"))
            except BrokerError:
                self._etf_cache[symbol] = False
        return self._etf_cache[symbol]

    # ------------------------------------------------------------------ data
    def get_quote(self, symbol: str) -> Quote:
        symbol = symbol.upper()
        if _is_occ(symbol):
            data = self._data("/v1beta1/options/quotes/latest", params={"symbols": symbol})
            q = data["quotes"][symbol]
            bid, ask = float(q["bp"]), float(q["ap"])
            return Quote(symbol, bid, ask, round((bid + ask) / 2, 2))
        q = self._data(f"/v2/stocks/{symbol}/quotes/latest")["quote"]
        t = self._data(f"/v2/stocks/{symbol}/trades/latest")["trade"]
        return Quote(symbol, float(q["bp"]), float(q["ap"]), float(t["p"]))

    def get_option_chain(self, underlying: str, expiration: date | None = None):
        params = {"underlying_symbols": underlying.upper(), "limit": 1000, "status": "active"}
        if expiration:
            params["expiration_date"] = expiration.isoformat()
        else:
            params["expiration_date_gte"] = (date.today() + timedelta(days=7)).isoformat()
            params["expiration_date_lte"] = (date.today() + timedelta(days=45)).isoformat()
        contracts = self._trading("GET", "/v2/options/contracts", params=params).get("option_contracts", [])
        symbols = [c["symbol"] for c in contracts][:100]
        if not symbols:
            return []
        quotes = self._data("/v1beta1/options/quotes/latest",
                            params={"symbols": ",".join(symbols)}).get("quotes", {})
        chain = []
        for sym in symbols:
            q = quotes.get(sym)
            if not q:
                continue
            bid, ask = float(q["bp"]), float(q["ap"])
            chain.append((OptionContract.from_occ(sym), Quote(sym, bid, ask, round((bid + ask) / 2, 2))))
        return chain

    def get_history(self, symbol: str, days: int = 60) -> list[float]:
        start = (datetime.now(timezone.utc) - timedelta(days=int(days * 1.6) + 5)).strftime("%Y-%m-%d")
        data = self._data(f"/v2/stocks/{symbol.upper()}/bars",
                          params={"timeframe": "1Day", "start": start, "limit": 10000, "adjustment": "all"})
        return [float(b["c"]) for b in (data.get("bars") or [])][-days:]

    def is_market_open(self) -> bool:
        return bool(self._trading("GET", "/v2/clock").get("is_open"))

    def get_fills(self, since: datetime | None = None) -> list[Fill]:
        """Executions from the account activities feed (FILL), oldest first."""
        params: dict = {"direction": "asc", "page_size": 100}
        if since:
            params["after"] = since.isoformat()
        fills: list[Fill] = []
        while True:
            page = self._trading("GET", "/v2/account/activities/FILL", params=params) or []
            for a in page:
                sym = a["symbol"]
                asset = AssetClass.OPTION if _is_occ(sym) else (
                    AssetClass.ETF if self._is_etf(sym) else AssetClass.STOCK)
                side = Side.BUY if a["side"] == "buy" else Side.SELL  # sell_short -> sell
                fills.append(Fill(a["id"], sym, side, float(a["qty"]), float(a["price"]), asset,
                                  datetime.fromisoformat(a["transaction_time"].replace("Z", "+00:00")),
                                  a.get("order_id", "")))
            if len(page) < params["page_size"]:
                return fills
            params["page_token"] = page[-1]["id"]

    # ---------------------------------------------------------------- orders
    def submit_order(self, order: Order) -> Order:
        body = {
            "symbol": order.symbol.upper(),
            "qty": str(order.qty),
            "side": order.side.value,
            "type": order.order_type.value,
            # Alpaca options only accept DAY orders.
            "time_in_force": TimeInForce.DAY.value if order.asset_class == AssetClass.OPTION
            else order.time_in_force.value,
            "client_order_id": order.client_order_id,
        }
        if order.limit_price is not None:
            body["limit_price"] = str(round(order.limit_price, 2))
        if order.stop_price is not None:
            body["stop_price"] = str(round(order.stop_price, 2))
        if order.asset_class == AssetClass.OPTION:
            body["position_intent"] = f"{order.side.value}_to_{order.intent.value}"
        resp = self._trading("POST", "/v2/orders", body=body)
        return self._apply(order, resp)

    def _apply(self, order: Order, resp: dict) -> Order:
        order.id = resp["id"]
        order.status = _STATUS.get(resp.get("status", ""), OrderStatus.PENDING)
        order.filled_qty = float(resp.get("filled_qty") or 0)
        if resp.get("filled_avg_price"):
            order.filled_avg_price = float(resp["filled_avg_price"])
        if resp.get("submitted_at"):
            order.submitted_at = datetime.fromisoformat(resp["submitted_at"].replace("Z", "+00:00"))
        return order

    def cancel_order(self, order_id: str) -> None:
        self._trading("DELETE", f"/v2/orders/{order_id}")

    def list_orders(self, status: str = "open") -> list[Order]:
        out = []
        for r in self._trading("GET", "/v2/orders", params={"status": status, "limit": 100}):
            asset = AssetClass.OPTION if r.get("asset_class") == "us_option" else AssetClass.STOCK
            o = Order(
                symbol=r["symbol"], qty=float(r.get("qty") or 0), side=Side(r["side"]),
                asset_class=asset, order_type=OrderType(r["type"]) if r["type"] in OrderType._value2member_map_ else OrderType.MARKET,
                limit_price=float(r["limit_price"]) if r.get("limit_price") else None,
                stop_price=float(r["stop_price"]) if r.get("stop_price") else None,
                client_order_id=r.get("client_order_id") or "",
            )
            out.append(self._apply(o, r))
        return out
