# Connecting a real broker or market data feed

The app talks to brokers through one interface, `Broker` in
[`server/src/brokers/broker.ts`](../server/src/brokers/broker.ts), and to market data through
`MarketDataProvider` in [`server/src/market/provider.ts`](../server/src/market/provider.ts).
The UI, storage, P&L views and WebSocket streaming don't change when you swap either one.

## 1. Add credentials

Open **Settings → Broker**, pick the broker, fill in the fields and click **Save credentials**.
They're written to `config/credentials.local.json` (mode 600, git-ignored). You can also
copy `config/credentials.example.json` there and edit it by hand.

## 2. Implement the adapter

`server/src/brokers/live.ts` has `RobinhoodBroker` and `WebullBroker` scaffolds that extend
`LiveBroker`. That base class already checks required credentials. Fill in:

| Method | Must return |
|---|---|
| `connect()` | authenticate. Throw on failure; the app stays on the previous broker |
| `account()` | `{ broker, cash, buyingPower, startingCash, realizedPnl }` |
| `positions()` | `[{ symbol, qty, avgCost, realizedPnl, openedAt }]` |
| `orders()` | `Order[]`, newest first |
| `fills(limit)` | `Fill[]`, newest first (`realizedPnl` per sell, if the broker provides it) |
| `placeOrder(req)` | the created `Order` (map the broker's status to `open/filled/cancelled/rejected`) |
| `cancelOrder(id)` | the updated `Order` |
| `watchedSymbols()` | symbols held or in open orders, so the quote stream includes them |

Call `this.emit("order", order)` when an order changes and `this.emit("portfolio")` when cash
or positions change, from the broker's streaming API if it has one or from a polling loop.
Every connected browser updates instantly.

Then set `implemented: true` for it in `server/src/brokers/index.ts`.

### Notes per broker

- **Webull**: Webull has an official OpenAPI (developer portal) with an app key/secret, signed
  requests and trading plus market data endpoints. That makes it the most direct path of the two.
- **Robinhood**: Robinhood doesn't publish an official API for stock trading. Community
  clients use the private endpoints the app uses, which can break or get your account
  flagged. Check Robinhood's terms before automating it.
- **Others with solid official APIs**: Alpaca, Interactive Brokers (Client Portal / TWS),
  Schwab, Tradier. To add one, copy a scaffold class, add an id to `BrokerId` in
  `server/src/config.ts`, and register it in `BROKERS` and `createBroker()`.

## 3. Real market data

Implement `MarketDataProvider` (`start`, `stop`, `setSymbols`, `snapshot`, `search`) for your
feed, for example the broker's own quote stream or Polygon, Finnhub, IEX or Alpaca data. Register it in
`server/src/market/index.ts`, then set it in `config/settings.local.json`:

```json
{ "marketData": { "provider": "yourprovider" } }
```

`setSymbols` receives the full set of symbols currently needed. Subscribe to the new ones and
unsubscribe from the rest. Push updates through the `onQuotes` callback in batches; the hub
handles coalescing and fan-out.

## 4. Go live (carefully)

1. Test the adapter with the broker's paper/sandbox environment if it has one.
2. **Settings → Safety → Allow orders on real-money brokers.** Until you do this, the server
   refuses every order sent to a live broker.
3. Each live order needs a "real-money order" confirmation in the ticket.
