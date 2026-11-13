import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type AppContext } from "../server.js";
import type { AppSettings } from "../config.js";
import type { MarketDataProvider } from "../market/provider.js";
import type { Quote } from "../types.js";
import { search } from "../market/catalog.js";
import { PaperBroker } from "../brokers/paper.js";
import { blackScholes, impliedVol } from "./bs.js";
import { describe as describeContract, expiryTime, formatOcc, parseOcc } from "./occ.js";
import { listExpirations, strikesAround } from "./chain.js";

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b}`);

// ------------------------------------------------------------------ pure functions

test("Black-Scholes matches textbook values", () => {
  // S=100 K=100 T=1 r=5% sigma=20%: call 10.4506, put 5.5735
  const c = blackScholes("C", 100, 100, 1, 0.05, 0, 0.2);
  const p = blackScholes("P", 100, 100, 1, 0.05, 0, 0.2);
  near(c.price, 10.4506, 1e-3, "call");
  near(p.price, 5.5735, 1e-3, "put");
  near(c.delta, 0.6368, 1e-3, "call delta");
  near(p.delta, -0.3632, 1e-3, "put delta");
  near(c.gamma, 0.018762, 1e-5, "gamma");
  near(c.vega, 0.37524, 1e-4, "vega per 1%");
  near(c.theta, -6.414 / 365, 1e-4, "call theta per day");
  near(p.theta, -1.658 / 365, 1e-4, "put theta per day");
  // put-call parity
  near(c.price - p.price, 100 - 100 * Math.exp(-0.05), 1e-6, "parity");
  // expired: intrinsic
  assert.equal(blackScholes("C", 110, 100, 0, 0.05, 0, 0.2).price, 10);
  assert.equal(blackScholes("P", 110, 100, 0, 0.05, 0, 0.2).price, 0);
});

test("implied volatility round-trips", () => {
  for (const sigma of [0.1, 0.35, 0.9]) {
    for (const right of ["C", "P"] as const) {
      const px = blackScholes(right, 230, 240, 45 / 365, 0.045, 0, sigma).price;
      near(impliedVol(right, px, 230, 240, 45 / 365, 0.045)!, sigma, 1e-4, `${right} ${sigma}`);
    }
  }
  assert.equal(impliedVol("C", 0.5, 100, 50, 0.5, 0.05), null); // below intrinsic
});

test("OCC symbols parse, format and describe", () => {
  const s = formatOcc("AAPL", "2026-11-20", "C", 232.5);
  assert.equal(s, "AAPL261120C00232500");
  const c = parseOcc(s)!;
  assert.deepEqual(c, { symbol: s, underlying: "AAPL", expiry: "2026-11-20", right: "C", strike: 232.5 });
  assert.equal(describeContract(c), "AAPL Nov 20 '26 $232.5 Call");
  assert.equal(parseOcc("AAPL"), null);
  assert.equal(parseOcc("AAPL261320C00232500"), null); // month 13
  // 4 pm New York: EST in November (21:00 UTC), EDT in July (20:00 UTC)
  assert.equal(new Date(expiryTime("2026-11-20")).toISOString(), "2026-11-20T21:00:00.000Z");
  assert.equal(new Date(expiryTime("2026-07-17")).toISOString(), "2026-07-17T20:00:00.000Z");
});

test("expirations and strikes", () => {
  const now = Date.parse("2026-11-13T15:00:00Z"); // Friday, 10 am New York
  const exps = listExpirations(now);
  assert.equal(exps[0].date, "2026-11-13"); // today's expiry still trades until 4 pm
  assert.equal(exps[0].dte, 0);
  assert.ok(exps.some((e) => e.date === "2026-11-20" && e.kind === "monthly")); // third Friday
  assert.ok(exps.some((e) => e.date === "2027-05-21")); // monthly ~6 months out
  const after = listExpirations(Date.parse("2026-11-13T22:00:00Z"));
  assert.equal(after[0].date, "2026-11-20"); // after the close, today's is gone
  assert.deepEqual(strikesAround(231.2, 2), [225, 227.5, 230, 232.5, 235]);
  assert.deepEqual(strikesAround(48.6, 1), [48, 49, 50]);
});

// ------------------------------------------------------------------ through the app

class FakeProvider implements MarketDataProvider {
  readonly name = "fake";
  prices = new Map<string, number>([["AAPL", 100]]);
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
  profitGuard: { enabled: false, dropPct: 5, floorPct: 0.25, disabledSymbols: [] },
  options: { riskFreeRate: 0.045 },
});

const call = async (method: string, url: string, body?: unknown) => {
  const res = await ctx.app.inject({ method: method as "GET", url, payload: body as object, headers: { host: "127.0.0.1" } });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "td-opt-"));
  provider = new FakeProvider();
  ctx = await buildApp(settings(), { provider, persistSettings: false });
});

/** A chain about a month out, so tests don't depend on today's date. */
async function chainFor(strikes: number) {
  const exps = (await call("GET", "/api/options/AAPL/expirations")).body.expirations as { date: string; dte: number }[];
  const exp = exps.find((e) => e.dte >= 25)!;
  return (await call("GET", `/api/options/AAPL/chain?strikes=${strikes}&expiry=${exp.date}`)).body;
}

afterEach(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("option chain: aligned strikes, live Greeks, put-call parity", async () => {
  assert.equal((await call("GET", "/api/options/aapl/chain?strikes=3")).status, 200);
  const c = await chainFor(3);
  assert.equal(c.underlying, "AAPL");
  assert.deepEqual(c.strikes, [92.5, 95, 97.5, 100, 102.5, 105, 107.5]);
  assert.equal(c.calls.length, 7);
  assert.equal(c.calls[3], formatOcc("AAPL", c.expiry, "C", 100));
  assert.equal(c.puts[3], formatOcc("AAPL", c.expiry, "P", 100));
  assert.equal(c.multiplier, 100);
  const bySym = new Map<string, Quote>(c.quotes.map((q: Quote) => [q.symbol, q]));
  for (let i = 0; i < 7; i++) {
    const call_ = bySym.get(c.calls[i])!, put = bySym.get(c.puts[i])!;
    assert.ok(call_.greeks!.delta > 0 && call_.greeks!.delta <= 1);
    assert.ok(put.greeks!.delta < 0 && put.greeks!.delta >= -1);
    assert.ok(call_.greeks!.theta <= 0, "long options lose value over time");
    assert.ok(call_.ask >= call_.bid && call_.oi! > 0);
    if (i > 0) assert.ok(call_.greeks!.delta < bySym.get(c.calls[i - 1])!.greeks!.delta, "call delta falls as strike rises");
  }
  // Parity at the money: C - P ≈ S - K·e^(-rT) (mids, within rounding of the spread)
  const atmC = bySym.get(c.calls[3])!, atmP = bySym.get(c.puts[3])!;
  const T = (expiryTime(c.expiry) - Date.now()) / (365 * 864e5);
  near((atmC.bid + atmC.ask) / 2 - (atmP.bid + atmP.ask) / 2, 100 - 100 * Math.exp(-0.045 * T), 0.02, "parity");
  // Expirations listed; an unknown expiry falls back to the nearest
  const other = (await call("GET", `/api/options/AAPL/chain?expiry=1999-01-01&strikes=2`)).body;
  assert.equal(other.expiry, c.expirations.find((e: { dte: number }) => e.dte >= 1).date);
  assert.equal((await call("GET", "/api/options/AAPL261120C00100000/chain")).status, 400);
});

test("buying and selling contracts moves cash ×100 and realizes P&L", async () => {
  const chain = await chainFor(2);
  const sym = chain.calls[2]; // ATM 100 call
  assert.equal((await call("POST", "/api/orders", { symbol: sym, side: "buy", qty: 1.5, type: "market" })).status, 400);
  assert.equal((await call("POST", "/api/orders", { symbol: sym, side: "sell", qty: 1, type: "market" })).status, 422); // nothing held

  const buy = (await call("POST", "/api/orders", { symbol: sym, side: "buy", qty: 2, type: "market" })).body;
  assert.equal(buy.status, "filled");
  const paid = buy.avgFillPrice;
  let acct = (await call("GET", "/api/account")).body;
  assert.equal(acct.cash, Math.round((10_000 - paid * 200) * 100) / 100);

  const pos = (await call("GET", "/api/positions")).body;
  assert.equal(pos[0].symbol, sym);
  assert.equal(pos[0].qty, 2);
  assert.equal(pos[0].avgCost, paid);

  // Too big for buying power: 100 contracts of a ~$4 option = ~$40k
  assert.equal((await call("POST", "/api/orders", { symbol: sym, side: "buy", qty: 100, type: "market" })).status, 422);

  provider.move("AAPL", 108); // call goes deep in the money
  const sell = (await call("POST", "/api/orders", { symbol: sym, side: "sell", qty: 2, type: "market" })).body;
  assert.equal(sell.status, "filled");
  assert.ok(sell.avgFillPrice > paid + 5);
  acct = (await call("GET", "/api/account")).body;
  assert.equal(acct.realizedPnl, Math.round((sell.avgFillPrice - paid) * 200 * 100) / 100);

  const inst = (await call("GET", `/api/instruments?symbols=${sym}`)).body[sym];
  assert.equal(inst.type, "option");
  assert.match(inst.name, /^AAPL .* \$100 Call$/);
  const pnl = (await call("GET", "/api/pnl")).body.bySymbol[0];
  assert.equal(pnl.buyValue, Math.round(paid * 200 * 100) / 100);
});

test("limit orders on options fill when the contract trades through", async () => {
  const chain = await chainFor(2);
  const put = chain.puts[2]; // 100 put
  const q = chain.quotes.find((x: Quote) => x.symbol === put);
  const limit = Math.round((q.ask - 1) * 100) / 100;
  const o = (await call("POST", "/api/orders", { symbol: put, side: "buy", qty: 1, type: "limit", limitPrice: limit })).body;
  assert.equal(o.status, "open");
  provider.move("AAPL", 104); // put cheapens
  const after = (await call("GET", "/api/orders")).body.find((x: { id: string }) => x.id === o.id);
  assert.equal(after.status, "filled");
  assert.ok(after.avgFillPrice <= limit);
});

test("expired contracts are cash-settled at intrinsic value", async () => {
  const chain = await chainFor(2);
  const [itmCall, otmPut] = [chain.calls[2], chain.puts[0]]; // 100 call, 95 put
  const a = (await call("POST", "/api/orders", { symbol: itmCall, side: "buy", qty: 1, type: "market" })).body;
  const b = (await call("POST", "/api/orders", { symbol: otmPut, side: "buy", qty: 3, type: "market" })).body;
  const cashAfterBuys = (await call("GET", "/api/account")).body.cash;
  provider.move("AAPL", 107);

  const broker = ctx.brokers.broker as PaperBroker;
  const settled = await broker.settleExpired(expiryTime(chain.expiry) + 1000);
  assert.equal(settled, 2);
  assert.equal((await call("GET", "/api/positions")).body.length, 0);
  const acct = (await call("GET", "/api/account")).body;
  assert.equal(acct.cash, Math.round((cashAfterBuys + 7 * 100) * 100) / 100); // call pays $7 × 100, put pays 0
  assert.equal(acct.realizedPnl, Math.round(((7 - a.avgFillPrice) * 100 - b.avgFillPrice * 300) * 100) / 100);
  const orders = (await call("GET", "/api/orders")).body.filter((o: { source?: string }) => o.source === "expiry");
  assert.equal(orders.length, 2);
});

test("options widgets: create, switch underlying, validation", async () => {
  const w = (await call("POST", "/api/widgets", { kind: "options", options: { underlying: "msft" } })).body;
  assert.equal(w.kind, "options");
  assert.equal(w.title, "MSFT options");
  assert.deepEqual(w.options, { underlying: "MSFT", strikes: 8, view: "both", greeks: true });

  const p = (await call("PATCH", `/api/widgets/${w.id}`, { options: { underlying: "NVDA", expiry: "2026-12-18", view: "puts", strikes: 5 } })).body;
  assert.equal(p.title, "NVDA options");
  assert.equal(p.options.expiry, "2026-12-18");
  assert.equal(p.options.view, "puts");
  const q = (await call("PATCH", `/api/widgets/${w.id}`, { options: { underlying: "AMD" } })).body;
  assert.equal(q.options.expiry, undefined, "expiry resets with a new underlying");

  assert.equal((await call("PATCH", `/api/widgets/${w.id}`, { options: { strikes: 99 } })).status, 400);
  assert.equal((await call("PATCH", `/api/widgets/${w.id}`, { options: { underlying: "AAPL261120C00100000" } })).status, 400);
  assert.equal((await call("PATCH", `/api/widgets/${w.id}`, { options: { view: "both", expiry: "next week" } })).status, 400);
  const list = (await call("GET", "/api/widgets")).body;
  const plain = list.find((x: { kind?: string }) => !x.kind);
  assert.equal((await call("PATCH", `/api/widgets/${plain.id}`, { options: { underlying: "AMD" } })).status, 400);
});
