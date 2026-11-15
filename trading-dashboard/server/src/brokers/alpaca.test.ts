import { test } from "node:test";
import assert from "node:assert/strict";

import { AlpacaBroker, verifyAlpacaKeys, withRealizedPnl } from "./alpaca.js";
import { fakeAlpaca, KEY, SECRET } from "./alpaca.fake.js";
import { AlpacaDataProvider, toQuote } from "../market/alpaca.js";
import { SwitchableProvider } from "../market/switchable.js";
import type { Fill, Order, Quote } from "../types.js";

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("alpaca: rejects bad keys with a clear message", async () => {
  const fake = fakeAlpaca();
  const url = await fake.start();
  try {
    const b = new AlpacaBroker("paper", { keyId: "WRONG", secretKey: "x" }, { tradingUrl: url });
    await assert.rejects(b.init(), /rejected the API keys.*paper keys/);
    await assert.rejects(new AlpacaBroker("paper", {}, { tradingUrl: url }).init(), /missing credentials/);
    await assert.rejects(verifyAlpacaKeys("live", { keyId: "WRONG", secretKey: "x" }, { tradingUrl: url }), /Alpaca \(live\).*live keys/);
    await verifyAlpacaKeys("paper", { keyId: KEY, secretKey: SECRET }, { tradingUrl: url });
  } finally {
    await fake.stop();
  }
});

test("alpaca: buy, fill, positions, realized P&L, sell, cancel", async () => {
  const fake = fakeAlpaca();
  const url = await fake.start();
  const b = new AlpacaBroker("paper", { keyId: KEY, secretKey: SECRET }, { tradingUrl: url, orderPollMs: 30, accountPollMs: 60 });
  const events: Order[] = [];
  let portfolio = 0;
  b.on("order", (o) => events.push(o));
  b.on("portfolio", () => portfolio++);
  try {
    await b.init();
    assert.equal(b.live, false);
    assert.equal(b.id, "alpaca-paper");
    assert.equal((await b.account()).cash, 10_000);

    const o = await b.placeOrder({ symbol: "aapl", side: "buy", qty: 10, type: "market", source: "manual" });
    assert.equal(o.status, "open");
    assert.equal(o.symbol, "AAPL");
    const sent = fake.state.orders.get(o.id)!;
    assert.match(String(sent.client_order_id), /^td-m-/);
    assert.equal(sent.time_in_force, "day");

    fake.fillAll();
    await waitFor(() => events.some((e) => e.id === o.id && e.status === "filled") && portfolio > 0);
    assert.deepEqual((await b.positions()).map((p) => [p.symbol, p.qty, p.avgCost]), [["AAPL", 10, 100]]);
    assert.equal((await b.account()).cash, 9000);
    assert.equal((await b.fills()).length, 1);
    assert.deepEqual(b.watchedSymbols(), ["AAPL"]);

    // selling more than held would open a short: refused before it reaches Alpaca
    await assert.rejects(b.placeOrder({ symbol: "AAPL", side: "sell", qty: 11, type: "market" }), /short position/);

    fake.state.price = 110;
    const sell = await b.placeOrder({ symbol: "AAPL", side: "sell", qty: 4, type: "market", source: "profit-guard" });
    assert.match(String(fake.state.orders.get(sell.id)!.client_order_id), /^td-pg-/);
    fake.fillAll();
    await waitFor(() => events.some((e) => e.id === sell.id && e.status === "filled"));
    await waitFor(() => (b as unknown as { fillsList: Fill[] }).fillsList.length === 2);
    const fills = await b.fills();
    assert.equal(fills[0].realizedPnl, 40);
    assert.equal((await b.account()).realizedPnl, 40);
    assert.equal((await b.orders()).find((x) => x.id === sell.id)!.source, "profit-guard");

    // a limit order rests; cancel it
    const lim = await b.placeOrder({ symbol: "AAPL", side: "buy", qty: 1, type: "limit", limitPrice: 50 });
    assert.equal(fake.state.orders.get(lim.id)!.limit_price, "50");
    const cancelled = await b.cancelOrder(lim.id);
    assert.equal(cancelled.status, "cancelled");

    // Alpaca refusing an order comes back as a rejected order with the reason
    const big = await b.placeOrder({ symbol: "MSFT", side: "buy", qty: 1000, type: "market" });
    assert.equal(big.status, "rejected");
    assert.match(big.reason!, /insufficient buying power/);

    // options: whole contracts, no stops
    await assert.rejects(b.placeOrder({ symbol: "AAPL261218C00230000", side: "buy", qty: 1.5, type: "limit", limitPrice: 2 }), /whole contracts/);
    assert.ok(fake.state.seenKeys.every((k) => k === KEY));
  } finally {
    await b.dispose();
    await fake.stop();
  }
});

test("alpaca: realized P&L replay uses average cost, options x100", () => {
  const f = (id: string, symbol: string, side: "buy" | "sell", qty: number, price: number, ts: number): Fill => ({ id, orderId: "o", symbol, side, qty, price, ts, realizedPnl: 0 });
  const out = withRealizedPnl([
    f("1", "X", "buy", 10, 10, 1), f("2", "X", "buy", 10, 20, 2), f("3", "X", "sell", 5, 30, 3),
    f("4", "AAPL261218C00230000", "buy", 1, 2, 4), f("5", "AAPL261218C00230000", "sell", 1, 3.5, 5),
  ]);
  assert.equal(out[2].realizedPnl, 75); // avg 15
  assert.equal(out[4].realizedPnl, 150);
});

test("alpaca market data: snapshots become quotes; switchable source swaps live", async () => {
  const fake = fakeAlpaca();
  const url = await fake.start();
  const data = new AlpacaDataProvider({ keyId: KEY, secretKey: SECRET }, { dataUrl: url, pollMs: 25 });
  try {
    const [q] = await data.snapshot(["SPY"]);
    assert.deepEqual([q.last, q.bid, q.ask, q.prevClose, q.high, q.volume], [100, 99.98, 100.03, 95, 101, 12345]);
    assert.equal((await data.search("ZZZQ"))[0].symbol, "ZZZQ");

    const stub = { name: "simulated", start() {}, stop() {}, setSymbols() {}, async snapshot() { return []; }, async search() { return []; } };
    const sw = new SwitchableProvider(stub);
    const got: Quote[] = [];
    sw.start((b) => got.push(...b));
    sw.setSymbols(["SPY", "QQQ"]);
    assert.equal(sw.name, "simulated");
    sw.swap(data);
    assert.equal(sw.name, "alpaca");
    await waitFor(() => got.some((x) => x.symbol === "QQQ"));
    sw.stop();
  } finally {
    data.stop();
    await fake.stop();
  }
});

test("alpaca market data: yesterday's bar is used as previous close before today's first trade", () => {
  const q = toQuote("SPY", {
    latestTrade: { p: 500, t: "2026-11-16T14:00:00Z" },
    dailyBar: { o: 1, h: 2, l: 0.5, c: 490, v: 10, t: "2026-11-13T05:00:00Z" },
    prevDailyBar: { c: 480 },
  })!;
  assert.equal(q.prevClose, 490);
  assert.equal(q.volume, 0);
});
