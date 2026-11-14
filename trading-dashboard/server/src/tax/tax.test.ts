import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../server.js";
import type { AppSettings } from "../config.js";
import type { MarketDataProvider } from "../market/provider.js";
import type { Fill, Quote } from "../types.js";
import { search } from "../market/catalog.js";
import { buildLots, longTermDate } from "./lots.js";
import { estimateTax, DEFAULT_PROFILE, type TaxProfile } from "./estimate.js";
import { loadTaxRules } from "./rules.js";

const rules = loadTaxRules();

// Noon New York time on a date, so NY-date conversion is unambiguous.
const at = (d: string) => Date.parse(`${d}T17:00:00Z`);
let seq = 0;
const fill = (symbol: string, side: "buy" | "sell", qty: number, price: number, date: string): Fill =>
  ({ id: `f${++seq}`, orderId: "o", symbol, side, qty, price, ts: at(date), realizedPnl: 0 });

test("FIFO lots, short vs long term at the one-year boundary", () => {
  assert.equal(longTermDate("2025-03-10"), "2026-03-11");
  assert.equal(longTermDate("2024-02-29"), "2025-03-01");
  const { closed, open } = buildLots([
    fill("AAA", "buy", 10, 100, "2025-03-10"),
    fill("AAA", "buy", 10, 120, "2025-06-01"),
    fill("AAA", "sell", 5, 150, "2026-03-10"), // exactly one year: still short-term
    fill("AAA", "sell", 10, 150, "2026-03-11"), // 5 from lot 1 (long), 5 from lot 2 (short)
  ]);
  assert.deepEqual(closed.map((l) => [l.qty, l.term, l.gain]), [[5, "short", 250], [5, "long", 250], [5, "short", 150]]);
  assert.equal(open.length, 1);
  assert.equal(open[0].qty, 5);
  assert.equal(open[0].cost, 600);
  assert.equal(open[0].longTermOn, "2026-06-02");
});

test("option lots use the 100x multiplier", () => {
  const sym = "AAPL261120C00225000";
  const { closed } = buildLots([fill(sym, "buy", 2, 3.5, "2026-10-01"), fill(sym, "sell", 2, 5, "2026-10-20")]);
  assert.equal(closed[0].gain, 300);
  assert.equal(closed[0].proceeds, 1000);
});

test("wash sale: loss disallowed when re-bought within 30 days", () => {
  const { closed } = buildLots([
    fill("BBB", "buy", 10, 50, "2026-01-05"),
    fill("BBB", "sell", 10, 40, "2026-02-01"), // -100 loss
    fill("BBB", "buy", 4, 41, "2026-02-20"), // re-bought 4 of 10 shares within 30 days
    fill("CCC", "buy", 10, 50, "2026-01-05"),
    fill("CCC", "sell", 10, 40, "2026-02-01"), // no repurchase: fully deductible
  ]);
  const b = closed.find((l) => l.symbol === "BBB")!;
  const c = closed.find((l) => l.symbol === "CCC")!;
  assert.equal(b.gain, -100);
  assert.equal(b.washDisallowed, 40);
  assert.equal(c.washDisallowed, 0);
});

const p = (x: Partial<TaxProfile>): TaxProfile => ({ ...DEFAULT_PROFILE, ...x });
const inv = (x: Partial<{ shortTerm: number; longTerm: number; qualifiedDividends: number; ordinaryDividends: number }>) =>
  ({ shortTerm: 0, longTerm: 0, qualifiedDividends: 0, ordinaryDividends: 0, ...x });

test("tax estimate: short-term gains at ordinary rates", () => {
  // Single, 2026: $80k wages - $16,100 std deduction = $63,900 taxable, in the 22% bracket.
  const e = estimateTax(p({ otherIncome: 80_000 }), inv({ shortTerm: 10_000 }), 2026, rules);
  assert.equal(e.rulesYear, 2026);
  assert.equal(e.taxOnInvestments, 2200);
  assert.equal(e.shortTermTax, 2200);
  assert.equal(e.marginalOrdinaryPct, 22);
});

test("tax estimate: long-term gains stack on top at 0% / 15%", () => {
  const low = estimateTax(p({ otherIncome: 40_000 }), inv({ longTerm: 20_000 }), 2026, rules);
  assert.equal(low.taxOnInvestments, 0); // 23,900 + 20,000 stays under the 0% limit of 49,450
  const mid = estimateTax(p({ otherIncome: 60_000 }), inv({ longTerm: 20_000 }), 2026, rules);
  assert.equal(mid.taxOnInvestments, 2167.5); // 5,550 at 0% + 14,450 at 15%
  assert.equal(mid.longTermTax, 2167.5);
  const divs = estimateTax(p({ otherIncome: 60_000 }), inv({ qualifiedDividends: 20_000 }), 2026, rules);
  assert.equal(divs.taxOnInvestments, 2167.5); // qualified dividends are taxed like long-term gains
});

test("tax estimate: losses deduct up to $3,000 and carry forward", () => {
  const e = estimateTax(p({ otherIncome: 80_000 }), inv({ shortTerm: -10_000 }), 2026, rules);
  assert.equal(e.lossDeducted, 3000);
  assert.equal(e.lossCarryforward, 7000);
  assert.equal(e.taxOnInvestments, -660);
  // Short-term loss offsets long-term gain first.
  const net = estimateTax(p({ otherIncome: 80_000 }), inv({ shortTerm: -4_000, longTerm: 10_000 }), 2026, rules);
  assert.equal(net.netLongTerm, 6000);
  assert.equal(net.netShortTerm, 0);
});

test("tax estimate: NIIT above the threshold, and state tax", () => {
  const e = estimateTax(p({ otherIncome: 250_000, stateRatePct: 5 }), inv({ longTerm: 50_000 }), 2026, rules);
  assert.equal(e.niit, 1900);
  assert.equal(e.stateTax, 2500);
  assert.equal(e.taxOnInvestments, 7500 + 1900 + 2500);
});

class FakeProvider implements MarketDataProvider {
  readonly name = "fake";
  prices = new Map<string, number>([["AAPL", 100]]);
  start() {}
  stop() {}
  setSymbols() {}
  quote(symbol: string): Quote {
    const px = this.prices.get(symbol) ?? 50;
    return { symbol, last: px, bid: px - 0.01, ask: px + 0.01, prevClose: 100, high: px, low: px, volume: 1, ts: Date.now() };
  }
  async snapshot(symbols: string[]) { return symbols.map((s) => this.quote(s)); }
  async search(q: string) { return search(q); }
}

test("tax API: report, profile and dividends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "td-tax-"));
  const settings: AppSettings = {
    host: "127.0.0.1", port: 0, dataDir: dir, broker: "paper", liveTradingEnabled: false,
    marketData: { provider: "fake", tickMs: 1000, volatility: 0, flushMs: 20 },
    paper: { startingCash: 100_000 },
    profitGuard: { enabled: false, dropPct: 5, floorPct: 0.25, disabledSymbols: [] },
    options: { riskFreeRate: 0.045 },
  };
  const ctx = await buildApp(settings, { provider: new FakeProvider(), persistSettings: false });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await ctx.app.inject({ method: method as "GET", url, payload: body as object, headers: { host: "127.0.0.1" } });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  try {
    assert.equal((await call("POST", "/api/orders", { symbol: "AAPL", side: "buy", qty: 10, type: "market" })).status, 201);
    assert.equal((await call("POST", "/api/orders", { symbol: "AAPL", side: "sell", qty: 4, type: "market" })).status, 201);

    assert.equal((await call("PUT", "/api/tax/profile", { filingStatus: "mfj", otherIncome: 120_000 })).body.filingStatus, "mfj");
    assert.equal((await call("PUT", "/api/tax/profile", { filingStatus: "nope" })).status, 400);
    assert.equal((await call("PUT", "/api/tax/profile", { otherIncome: -5 })).status, 400);

    const year = new Date().getFullYear();
    const div = await call("POST", "/api/dividends", { symbol: "aapl", date: `${year}-02-14`, amount: 12.5, qualified: true });
    assert.equal(div.status, 201);
    assert.equal(div.body.symbol, "AAPL");
    assert.equal((await call("POST", "/api/dividends", { symbol: "AAPL", date: "14/02/2026", amount: 1 })).status, 400);
    assert.equal((await call("POST", "/api/dividends", { symbol: "AAPL", date: `${year}-02-14`, amount: -1 })).status, 400);

    const r = (await call("GET", `/api/tax/report?year=${year}`)).body;
    assert.equal(r.method, "FIFO");
    assert.equal(r.profile.filingStatus, "mfj");
    assert.equal(r.realized.short.count, 1);
    assert.equal(r.realized.lots[0].qty, 4);
    assert.equal(r.unrealized.lots[0].qty, 6);
    assert.equal(r.unrealized.lots[0].term, "short");
    assert.equal(r.dividends.qualified, 12.5);
    assert.ok(r.bySymbol.find((s: { symbol: string }) => s.symbol === "AAPL"));
    assert.equal(typeof r.estimate.taxOnInvestments, "number");
    assert.equal((await call("GET", "/api/tax/report?year=abc")).status, 400);

    assert.equal((await call("DELETE", `/api/dividends/${div.body.id}`)).status, 204);
    assert.equal((await call("DELETE", `/api/dividends/${div.body.id}`)).status, 404);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


