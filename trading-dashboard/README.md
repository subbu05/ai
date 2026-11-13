# Trading Dashboard

A fast, local trading dashboard: a **React** widgets UI plus a **Fastify + WebSocket** backend
with pluggable brokers. Everything (widgets, orders, fills, positions, settings, credentials)
is stored as plain files on your machine.

- **Widgets**: create as many as you like. Each one has a title and a list of stocks/ETFs
  showing **what you paid** (average cost) next to the **last price** (with % vs paid), the day
  change, a **Total P&L per ticker** (realized on closed trades + unrealized now), bid × ask, and
  Buy/Sell. You can rename (double-click the title), sort (manual, symbol, % change, price),
  collapse, delete, and drag widgets to reorder.
- **Order ticket**: buy or sell with **market, limit, stop and stop-limit** orders, by shares or
  by dollars (fractional), with day/GTC time in force. It shows estimated cost and buying power.
- **Kill switch (automatic, can be turned on and off)**: the **🛡 Kill switch ON/OFF** toggle in the
  header arms or disarms automatic selling for all positions. Every ticker you hold also gets its
  own **🛡 ON/OFF** toggle (in its widget row and in Positions), so you can exclude individual
  stocks. While a ticker is off, its daily high is still tracked, so turning it back on works
  correctly. What it does when armed is described next.
- **Sell all now / Exit**: the red **⛔ Sell all now** button cancels every open order and
  market-sells every position at once, locking in whatever profit or loss you have right then.
  Each position also has an **Exit** button that does the same for one ticker. The confirmation
  shows, live, what you'd lock in per position.
- **What the armed kill switch does** (on by default at 5%): once a held
  stock/ETF has been in profit today, the server sells the whole position if its bid falls
  **5% from today's high**, and never lets the trigger drop below **your cost + 0.25%**. The
  cushion covers the spread and small jumps, so a winner is normally sold at or above what you
  paid. Positions that haven't been in profit today are left alone. It runs on every price tick,
  even with the browser closed. Change the % and the cushion, or turn it off, in **Settings**.
- **Portfolio**: positions with average cost, market value, day P&L, unrealized and total P&L,
  the profit-protection trigger price per position, open/closed orders with cancel, the full
  fill history, win rate, and a cumulative realized P&L chart.
- **Brokers**: a full **paper broker** (simulated fills against live quotes) works out of the
  box. **Robinhood** and **Webull** adapters are scaffolded: credentials and settings UI are
  done, and the API calls are left to implement. See [docs/BROKERS.md](docs/BROKERS.md).

> Prices are **simulated** until you plug in a real market data provider. This is not
> investment advice. Use paper trading until you trust every line that touches a real account.
> The kill switch and profit protection use **market orders**: they get you out fast, but no
> market order can guarantee a price. A sudden gap can fill below the trigger.

## Quick start

Requires **Node.js 20+**.

```bash
cd trading-dashboard
npm install
npm run dev          # API on :8787 + Vite dev server on http://127.0.0.1:5173
```

Production-style (one process, serves the built UI):

```bash
npm run build
npm start            # http://127.0.0.1:8787
```

Other commands: `npm test` (server tests), `npm run typecheck`.

## Where things are stored

| Path | What | Git |
|---|---|---|
| `config/settings.json` | Defaults (port, broker, market data, paper cash, profit protection) | committed |
| `config/settings.local.json` | Your overrides (written by the Settings dialog) | ignored |
| `config/credentials.local.json` | Broker API keys / logins, mode `600` | ignored |
| `data/widgets.json` | Your widgets and their symbols | ignored |
| `data/paper/account.json`, `positions.json`, `orders.json` | Paper account state | ignored |
| `data/paper/fills.jsonl` | Append-only fill log (audit trail, source of P&L history) | ignored |
| `data/profit-guard.json`, `profit-guard.log.jsonl` | Today's peak per position; every automatic sell | ignored |
| `data/kill-switch.log.jsonl` | Every kill-switch / Exit run and its results | ignored |

JSON files are written atomically (temp file + rename) and coalesced, so a crash can't
corrupt them and bursts of activity cost one disk write. Set `TD_HOME` to keep `config/` and
`data/` somewhere else.

## How profit protection decides

For each held position, every tick:

1. Track **today's high** (resets each day).
2. **Floor** = average cost × (1 + cushion%), default cushion 0.25%.
3. The position is **armed** once its **bid** (what a sale would get) is above the floor.
4. **Trigger** = max(today's high × (1 − 5%), floor).
5. When an armed position's bid falls to the trigger (and both the master switch and that
   ticker's switch are ON): cancel its open sell orders and sell the
   whole position at market. The Orders tab marks it 🛡 *auto*, and you get a notification.

The Positions tab shows each position's toggle and current trigger price, or
"not in profit" if it hasn't armed today.

## Performance design

**Backend** (`server/src`)
- One `QuoteHub` caches quotes and tracks *demand* (widgets, positions, open orders, each
  connected client). The data provider only streams that union.
- Ticks go straight to the broker and the profit guard (resting limit/stop orders are indexed
  by symbol, so a tick only checks orders for that symbol).
- UI fan-out is **coalesced** every `flushMs` (100 ms): a symbol that ticks ten times in a
  window is sent once. Each changed quote is serialized **once** into a compact array
  (`[sym,last,bid,ask,prevClose,high,low,vol,ts]`) and the fragments are spliced into each
  client's frame. Clients only get symbols they subscribed to.
- Slow clients are detected via `bufferedAmount`. Deltas are skipped and the client is
  resynced with a full snapshot once it drains, so one slow tab can't grow server memory.
- Measured locally: 20 clients × 300 symbols ≈ 12k quote rows/s at about 2% of one CPU core.

**Frontend** (`web/src`)
- The quote store is outside React, with **per-symbol subscriptions** via
  `useSyncExternalStore`. A tick for AAPL re-renders only the AAPL rows.
- Incoming updates are **batched per animation frame**, so there's at most one render pass per frame.
- Rows, widgets and position rows are memoized. Value-based sorts re-order once a second
  rather than on every tick. Price flashes are pure CSS, with no timers or effects.
- No UI framework or state library.

## Security

- The server binds to `127.0.0.1` only. It rejects requests whose `Host` isn't localhost
  (to block DNS rebinding) and cross-origin requests (so other web pages can't place orders).
- Credentials never go back to the browser. The API only reports which fields are set.
- Real-money brokers need **Settings → Safety → "Allow orders on real-money brokers"**. Until
  then, manual orders, the kill switch and profit protection all refuse to trade on a live
  broker. Each live order also needs an extra confirmation checkbox in the ticket.

## API (for scripts / other tools)

| Method | Path | |
|---|---|---|
| GET | `/api/bootstrap` | everything the UI needs on load |
| GET/POST | `/api/widgets` | list / create `{title, symbols}` |
| PATCH/DELETE | `/api/widgets/:id` | update `{title?, symbols?, sort?, collapsed?}` / delete |
| PUT | `/api/widgets/order` | reorder `{ids: [...]}` |
| GET | `/api/quotes?symbols=AAPL,SPY` | snapshot |
| GET | `/api/instruments/search?q=app` | symbol search |
| GET | `/api/account`, `/api/positions`, `/api/orders`, `/api/fills`, `/api/pnl` | portfolio |
| POST | `/api/orders` | `{symbol, side, qty, type, limitPrice?, stopPrice?, tif?}` |
| DELETE | `/api/orders/:id` | cancel |
| POST | `/api/kill-switch` | `{symbols?}`: cancel open orders and market-sell all (or listed) positions |
| GET | `/api/profit-guard` | kill-switch settings, per-position peak/trigger price, recent automatic sells |
| PUT | `/api/profit-guard/symbols/:symbol` | `{enabled}`: per-ticker kill switch on/off |
| POST | `/api/paper/reset` | `{startingCash?}` |
| GET/PUT | `/api/settings` | `{broker?, liveTradingEnabled?, profitGuard?: {enabled?, dropPct?, floorPct?}}` (`enabled` = master kill switch) |
| PUT | `/api/credentials/:broker` | `{fields: {...}}` |
| WS | `/ws` | send `{"t":"sub","symbols":[...]}`; receive `q` (quotes), `order`, `pf` (portfolio), `guard`, `kill`, `settings`, `broker` |
