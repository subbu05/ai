# Live prices

In paper mode the app can use **live prices** instead of the offline simulator. Quotes, the
watchlist, the monitor, P&L, the basket buyer and paper fills all use the configured source.
In `alpaca-paper` / `alpaca-live` mode, prices always come from Alpaca, your broker.

| Provider | Key | What you get | Notes |
|---|---|---|---|
| `yahoo` | none | last price + daily history for US stocks/ETFs | Yahoo Finance's public chart endpoint. **Unofficial**: no bid/ask, may be delayed, can change or rate-limit without notice; personal use |
| `finnhub` | free key from [finnhub.io](https://finnhub.io) | **real-time** US last price | free tier is roughly 60 calls/min; history falls back to Yahoo |
| `alpaca` | free Alpaca account (paper keys work) | **real-time IEX** bid/ask/last + daily bars | free "Basic" plan = IEX exchange only; paid plan adds all exchanges (`ALPACA_DATA_FEED=sip`) |
| `simulated` | none | offline random walk | default; nothing leaves your computer |

## Set it up

```bash
python -m trading_agent secrets set market_data.provider     # e.g.  yahoo   or   finnhub,yahoo
python -m trading_agent secrets set finnhub.api_key          # only for finnhub
python -m trading_agent quote AAPL MSFT                      # shows the price and its source
```

Or set `MARKET_DATA=finnhub,yahoo` in `.env` (non-secret). A **comma list is a fallback
chain**: if Finnhub fails or hits its limit, Yahoo is used.

Recommended:
- No sign-ups: `yahoo`
- Real-time and free: `finnhub,yahoo` (Finnhub key) or `alpaca,yahoo` (Alpaca paper keys, which also give bid/ask)

## How it behaves

- **Caching:** quotes are cached 15 s (`MARKET_DATA_TTL`), history 1 h, so the UI refreshing
  every 5 s doesn't burn through API limits.
- **Rate limits:** calls per provider are capped below the free-tier limits. When a provider
  is busy or down, the next one in the chain is used. If all fail, the last good price is
  served and marked stale (`quote` shows `source_by_symbol: "... (stale)"`). With no price at
  all, you get a clear error, not a made-up price.
- **Keys** are sent in headers, never in URLs, and are stored only in the local accounts file.
- **Paper fills on live prices:** market orders fill at the provider's ask/bid. Yahoo and
  Finnhub have no bid/ask, so fills happen at the last price. Resting limit orders, such as
  the basket's 5%-below orders, fill when the live price reaches them, checked whenever the
  monitor or UI refreshes.
- The web UI header shows the active source under **Prices**.

## Not provided

There is no options-chain data from these sources. Paper option quotes are modelled with
Black-Scholes from the live underlying price. Real option chains come from your broker in
Alpaca mode.
