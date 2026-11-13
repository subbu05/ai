import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { buildApp, type AppContext } from "./server.js";
import type { AppSettings } from "./config.js";
import type { MarketDataProvider } from "./market/provider.js";
import type { Quote, Order } from "./types.js";
import { search } from "./market/catalog.js";
import { round2 } from "./util.js";

/** Deterministic provider: prices only move when the test pushes them. */
class FakeProvider implements MarketDataProvider {
  readonly name = "fake";
  prices = new Map<string, number>([["AAPL", 100], ["SPY", 500]]);
  push: ((q: Quote[]) => void) | null = null;
  start(cb: (q: Quote[]) => void) { this.push = cb; }
  stop() {}
  setSymbols() {}
  quote(symbol: string): Quote {
    const p = this.prices.get(symbol) ?? 50;
    return { symbol, last: p, bid: p - 0.01, ask: p + 0.01, prevClose: 100, high: p, low: p, volume: 1, ts: Date.now() };
  }
  async snapshot(symbols: string[]) { return symbols.map((s) => this.quote(s)); }
  async search(q: string) { return search(q); }
  move(symbol: string, price: number) {
    this.prices.set(symbol, price);
    this.push!([this.quote(symbol)]);
  }
}

let dir: string;
let ctx: AppContext;
let provider: FakeProvider;

const settings = (): AppSettings => ({
  host: "127.0.0.1", port: 0, dataDir: dir, broker: "paper", liveTradingEnabled: false,
  marketData: { provider: "fake", tickMs: 1000, volatility: 0, flushMs: 20 },
  paper: { startingCash: 10_000 },
  profitGuard: { enabled: true, dropPct: 5, floorPct: 0.25, disabledSymbols: [] },
});

const call = async (method: string, url: string, body?: unknown) => {
  const res = await ctx.app.inject({ method: method as "GET", url, payload: body as object, headers: { host: "127.0.0.1" } });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "td-test-"));
  provider = new FakeProvider();
  ctx = await buildApp(settings(), { provider, persistSettings: false });
});

afterEach(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("market buy fills at ask, sell realizes P&L at bid", async () => {
  const buy = await call("POST", "/api/orders", { symbol: "aapl", side: "buy", qty: 10, type: "market" });
  assert.equal(buy.status, 201);
  assert.equal(buy.body.status, "filled");
  assert.equal(buy.body.avgFillPrice, 100.01);

  provider.move("AAPL", 110);
  const sell = await call("POST", "/api/orders", { symbol: "AAPL", side: "sell", qty: 4, type: "market" });
  assert.equal(sell.body.avgFillPrice, 109.99);

  const pos = (await call("GET", "/api/positions")).body;
  assert.equal(pos.length, 1);
  assert.equal(pos[0].qty, 6);
  assert.equal(pos[0].avgCost, 100.01);

  const acct = (await call("GET", "/api/account")).body;
  assert.equal(acct.realizedPnl, 39.92); // (109.99 - 100.01) * 4
  assert.equal(acct.cash, Math.round((10_000 - 1000.1 + 439.96) * 100) / 100);

  const pnl = (await call("GET", "/api/pnl")).body;
  assert.equal(pnl.bySymbol[0].symbol, "AAPL");
  assert.equal(pnl.bySymbol[0].realizedPnl, 39.92);
});

test("limit buy rests until the ask crosses, then fills", async () => {
  const o = (await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 5, type: "limit", limitPrice: 95 })).body as Order;
  assert.equal(o.status, "open");
  // Cash is reserved for the resting order.
  assert.equal((await call("GET", "/api/account")).body.buyingPower, 10_000 - 475);

  provider.move("AAPL", 97);
  assert.equal((await call("GET", "/api/orders")).body[0].status, "open");

  provider.move("AAPL", 94);
  const filled = (await call("GET", "/api/orders")).body[0];
  assert.equal(filled.status, "filled");
  assert.equal(filled.avgFillPrice, 94.01);
});

test("stop sell triggers when price falls through the stop", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 2, type: "market" });
  const stop = (await call("POST", "/api/orders", { symbol: "AAPL", side: "sell", qty: 2, type: "stop", stopPrice: 90 })).body;
  assert.equal(stop.status, "open");
  provider.move("AAPL", 91);
  assert.equal((await call("GET", "/api/positions")).body.length, 1);
  provider.move("AAPL", 89.5);
  assert.equal((await call("GET", "/api/positions")).body.length, 0);
});

test("rejects overspending and selling shares you don't have", async () => {
  const big = await call("POST", "/api/orders", { symbol: "SPY", side: "buy", qty: 100, type: "market" });
  assert.equal(big.status, 422);
  assert.match(big.body.reason, /buying power/);

  const naked = await call("POST", "/api/orders", { symbol: "SPY", side: "sell", qty: 1, type: "market" });
  assert.equal(naked.status, 422);
  assert.match(naked.body.reason, /Insufficient shares/);

  const bad = await call("POST", "/api/orders", { symbol: "SPY", side: "buy", qty: -1, type: "market" });
  assert.equal(bad.status, 400);
});

test("cancel releases reserved buying power", async () => {
  const o = (await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 10, type: "limit", limitPrice: 50 })).body;
  const c = await call("DELETE", `/api/orders/${o.id}`);
  assert.equal(c.body.status, "cancelled");
  assert.equal((await call("GET", "/api/account")).body.buyingPower, 10_000);
  assert.equal((await call("DELETE", `/api/orders/${o.id}`)).status, 409);
});

test("widgets CRUD persists to local files", async () => {
  const initial = (await call("GET", "/api/widgets")).body;
  assert.equal(initial.length, 4); // 3 watchlists + 1 options chain

  const w = (await call("POST", "/api/widgets", { title: "Mine", symbols: ["tsla", "TSLA", "voo"] })).body;
  assert.deepEqual(w.symbols, ["TSLA", "VOO"]);
  const p = (await call("PATCH", `/api/widgets/${w.id}`, { title: "Renamed", sort: "change" })).body;
  assert.equal(p.title, "Renamed");
  assert.equal((await call("PATCH", `/api/widgets/${w.id}`, { symbols: ["$$$"] })).status, 400);

  await call("PUT", "/api/widgets/order", { ids: [w.id] });
  assert.equal((await call("GET", "/api/widgets")).body[0].id, w.id);

  ctx.storage.flushAll();
  const onDisk = JSON.parse(readFileSync(join(dir, "widgets.json"), "utf8"));
  assert.equal(onDisk[0].title, "Renamed");

  assert.equal((await call("DELETE", `/api/widgets/${w.id}`)).status, 204);
  assert.equal((await call("GET", "/api/widgets")).body.length, 4);
});

test("state survives a restart", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 3, type: "market" });
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 1, type: "limit", limitPrice: 80 });
  await ctx.close();

  provider = new FakeProvider();
  ctx = await buildApp(settings(), { provider, persistSettings: false });
  assert.equal((await call("GET", "/api/positions")).body[0].qty, 3);
  assert.equal((await call("GET", "/api/fills")).body.length, 1);
  provider.move("AAPL", 79);
  assert.equal((await call("GET", "/api/positions")).body[0].qty, 4); // resting order reloaded and filled
});

test("live brokers refuse to activate without credentials", async () => {
  const r = await call("PUT", "/api/settings", { broker: "webull" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /missing credentials/);
  assert.equal((await call("GET", "/api/health")).body.broker, "paper");
});

test("blocks cross-origin and non-local Host requests", async () => {
  const evil = await ctx.app.inject({ method: "GET", url: "/api/account", headers: { host: "127.0.0.1:8787", origin: "https://evil.example" } });
  assert.equal(evil.statusCode, 403);
  const rebind = await ctx.app.inject({ method: "GET", url: "/api/account", headers: { host: "attacker.example" } });
  assert.equal(rebind.statusCode, 403);
  // another local site (different port) can't place orders either
  const otherPort = await ctx.app.inject({ method: "POST", url: "/api/orders", payload: { symbol: "AAA", side: "buy", qty: 1, type: "market" },
    headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:3000" } });
  assert.equal(otherPort.statusCode, 403);
  const nullOrigin = await ctx.app.inject({ method: "POST", url: "/api/kill-switch", payload: {}, headers: { host: "127.0.0.1:8787", origin: "null" } });
  assert.equal(nullOrigin.statusCode, 403);
  const crossSite = await ctx.app.inject({ method: "GET", url: "/api/account", headers: { host: "127.0.0.1:8787", "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.statusCode, 403);
  // the dashboard's own page is allowed
  const own = await ctx.app.inject({ method: "GET", url: "/api/account", headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "sec-fetch-site": "same-origin" } });
  assert.equal(own.statusCode, 200);
});

test("sends browser security headers and keeps data files private", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/account", headers: { host: "127.0.0.1" } });
  assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cache-control"], "no-store");
  await call("POST", "/api/orders", { symbol: "AAA", side: "buy", qty: 1, type: "market" });
  ctx.storage.flushAll();
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      const st = statSync(join(dir, f));
      if (st.isFile()) assert.equal(st.mode & 0o077, 0, `${f} must not be readable by others`);
    }
  }
});

test("websocket streams only subscribed symbols, batched", async () => {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = ctx.app.server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: { t: string; d: unknown }[] = [];
  ws.on("message", (m) => frames.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "sub", symbols: ["AAPL"] }));
  await new Promise((r) => setTimeout(r, 50));
  frames.length = 0;

  provider.move("SPY", 501); // not subscribed
  provider.move("AAPL", 101);
  provider.move("AAPL", 102); // coalesced with the previous tick
  await new Promise((r) => setTimeout(r, 80));
  ws.close();

  const q = frames.filter((f) => f.t === "q");
  assert.equal(q.length, 1);
  const rows = q[0].d as unknown[][];
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], "AAPL");
  assert.equal(rows[0][1], 102);
});

// ------------------------------------------------------------------ profit guard
const settle = () => new Promise((r) => setTimeout(r, 30));

test("profit guard sells after a 5% pullback from today's high", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 10, type: "market" }); // cost 100.01
  await settle();
  provider.move("AAPL", 120); // in profit, peak 120 -> trigger 114
  provider.move("AAPL", 114.5);
  await settle();
  let g = (await call("GET", "/api/profit-guard")).body;
  assert.equal(g.positions[0].triggerPrice, 114);
  assert.equal((await call("GET", "/api/positions")).body.length, 1);

  provider.move("AAPL", 113.9);
  await settle();
  assert.equal((await call("GET", "/api/positions")).body.length, 0);
  const sell = (await call("GET", "/api/orders")).body.find((o: Order) => o.side === "sell");
  assert.equal(sell.source, "profit-guard");
  assert.ok((await call("GET", "/api/account")).body.realizedPnl > 0);
  g = (await call("GET", "/api/profit-guard")).body;
  assert.equal(g.events[0].action, "sell");
  assert.equal(g.events[0].qty, 10);
  assert.match(g.events[0].message, /sold 10 AAPL/);
});

test("profit guard never lets a winner turn into a loss (break-even floor)", async () => {
  await call("PUT", "/api/settings", { profitGuard: { dropPct: 50 } });
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 5, type: "market" }); // cost 100.01
  await settle();
  provider.move("AAPL", 104); // armed; 50% below peak is 52, so the floor (cost + 0.25% = 100.26) applies
  provider.move("AAPL", 100.5); // bid 100.49: still above the floor
  await settle();
  assert.equal((await call("GET", "/api/positions")).body.length, 1);
  provider.move("AAPL", 100.2); // bid 100.19 <= 100.26 -> sell, still above cost
  await settle();
  assert.equal((await call("GET", "/api/positions")).body.length, 0);
  assert.ok((await call("GET", "/api/account")).body.realizedPnl > 0);
});

test("profit guard ignores positions that were never in profit, and can be disabled", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 5, type: "market" });
  await settle();
  provider.move("AAPL", 95);
  provider.move("AAPL", 80);
  await settle();
  assert.equal((await call("GET", "/api/positions")).body.length, 1);

  await call("PUT", "/api/settings", { profitGuard: { enabled: false } });
  provider.move("AAPL", 130);
  provider.move("AAPL", 100);
  await settle();
  assert.equal((await call("GET", "/api/positions")).body.length, 1);

  assert.equal((await call("PUT", "/api/settings", { profitGuard: { dropPct: 0 } })).status, 400);
});

test("profit guard frees shares held by a resting sell limit", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 4, type: "market" });
  await call("POST", "/api/orders", { symbol: "AAPL", side: "sell", qty: 4, type: "limit", limitPrice: 200 });
  await settle();
  provider.move("AAPL", 110);
  provider.move("AAPL", 104);
  await settle();
  assert.equal((await call("GET", "/api/positions")).body.length, 0);
  const statuses = (await call("GET", "/api/orders")).body.map((o: Order) => `${o.type}:${o.status}`);
  assert.ok(statuses.includes("limit:cancelled"));
});

test("profit guard doesn't arm on a profit smaller than the cushion", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 5, type: "market" }); // cost 100.01
  await settle();
  provider.move("AAPL", 100.2); // bid 100.19: a few cents up, below cost + 0.25%
  provider.move("AAPL", 99);
  await settle();
  assert.equal((await call("GET", "/api/positions")).body.length, 1);
  assert.equal((await call("GET", "/api/profit-guard")).body.positions[0].armed, false);
});

// ------------------------------------------------------------------ kill switch
test("kill switch cancels open orders and sells every position at market", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 10, type: "market" });
  await call("POST", "/api/orders", { symbol: "SPY", side: "buy", qty: 2, type: "market" });
  await call("POST", "/api/orders", { symbol: "AAPL", side: "sell", qty: 5, type: "limit", limitPrice: 999 });
  await call("POST", "/api/orders", { symbol: "SPY", side: "buy", qty: 1, type: "limit", limitPrice: 1 });
  provider.move("AAPL", 105);
  provider.move("SPY", 490);

  const r = (await call("POST", "/api/kill-switch", {})).body;
  assert.equal(r.cancelledOrders, 2);
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((x: { status: string }) => x.status === "filled"));
  const aapl = r.results.find((x: { symbol: string }) => x.symbol === "AAPL");
  assert.equal(aapl.pnl, round2((104.99 - 100.01) * 10)); // profit locked in
  const spy = r.results.find((x: { symbol: string }) => x.symbol === "SPY");
  assert.ok(spy.pnl < 0); // loss stopped from growing
  assert.equal((await call("GET", "/api/positions")).body.length, 0);
  assert.equal((await call("GET", "/api/orders")).body.filter((o: Order) => o.status === "open").length, 0);
});

test("kill switch can target a single ticker", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 1, type: "market" });
  await call("POST", "/api/orders", { symbol: "SPY", side: "buy", qty: 1, type: "market" });
  const r = (await call("POST", "/api/kill-switch", { symbols: ["aapl"] })).body;
  assert.deepEqual(r.results.map((x: { symbol: string }) => x.symbol), ["AAPL"]);
  const left = (await call("GET", "/api/positions")).body;
  assert.deepEqual(left.map((p: { symbol: string }) => p.symbol), ["SPY"]);
});

test("kill switch can be switched off for one ticker and back on", async () => {
  await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 2, type: "market" });
  await call("POST", "/api/orders", { symbol: "SPY", side: "buy", qty: 2, type: "market" });
  assert.equal((await call("PUT", "/api/profit-guard/symbols/aapl", { enabled: false })).status, 200);
  assert.equal((await call("PUT", "/api/profit-guard/symbols/AAPL", { enabled: "no" })).status, 400);
  await settle();
  provider.move("AAPL", 120);
  provider.move("SPY", 520);
  provider.move("AAPL", 100.5); // would trigger, but AAPL is switched off
  provider.move("SPY", 500.5); // triggers (floor 500.01 * 1.0025 = 501.26)
  await settle();
  let held = (await call("GET", "/api/positions")).body.map((p: { symbol: string }) => p.symbol);
  assert.deepEqual(held, ["AAPL"]);
  const st = (await call("GET", "/api/profit-guard")).body.positions[0];
  assert.equal(st.enabled, false);
  assert.equal(st.peak, 120); // still tracked while off

  await call("PUT", "/api/profit-guard/symbols/AAPL", { enabled: true });
  provider.move("AAPL", 100.4);
  await settle();
  held = (await call("GET", "/api/positions")).body;
  assert.equal(held.length, 0);
});
