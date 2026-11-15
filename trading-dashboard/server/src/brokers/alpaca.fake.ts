import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Test helper: a tiny in-memory imitation of Alpaca's trading + data APIs. Not used by the app. */
export const KEY = "PKTEST", SECRET = "s3cret";

export function fakeAlpaca() {
  const state = {
    cash: 10_000,
    positions: new Map<string, { qty: number; avg: number }>(),
    orders: new Map<string, Record<string, unknown>>(),
    fills: [] as Record<string, unknown>[],
    price: 100,
    seq: 0,
    seenKeys: [] as string[],
  };
  const send = (res: ServerResponse, code: number, body?: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const fill = (o: Record<string, unknown>) => {
    const qty = Number(o.qty), sym = String(o.symbol), side = String(o.side);
    const p = state.positions.get(sym) ?? { qty: 0, avg: 0 };
    if (side === "buy") { p.avg = (p.avg * p.qty + qty * state.price) / (p.qty + qty); p.qty += qty; state.cash -= qty * state.price; }
    else { p.qty -= qty; state.cash += qty * state.price; }
    if (p.qty > 0) state.positions.set(sym, p); else state.positions.delete(sym);
    Object.assign(o, { status: "filled", filled_qty: String(qty), filled_avg_price: String(state.price), updated_at: new Date().toISOString() });
    state.fills.push({ id: `act${++state.seq}`, activity_type: "FILL", transaction_time: new Date().toISOString(), price: String(state.price), qty: String(qty), side, symbol: sym, order_id: o.id });
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    state.seenKeys.push(String(req.headers["apca-api-key-id"]));
    if (req.headers["apca-api-key-id"] !== KEY || req.headers["apca-api-secret-key"] !== SECRET) return send(res, 401, { message: "unauthorized." });
    const url = new URL(req.url!, "http://x");
    let body: Record<string, string> = {};
    if (req.method === "POST") body = JSON.parse(await new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }));
    const p = url.pathname;
    if (p === "/v2/account") return send(res, 200, { cash: String(state.cash), buying_power: String(state.cash * 2), equity: String(state.cash), last_equity: "10000", status: "ACTIVE", trading_blocked: false, account_blocked: false, currency: "USD" });
    if (p === "/v2/positions") return send(res, 200, [...state.positions].map(([symbol, v]) => ({ symbol, qty: String(v.qty), avg_entry_price: String(v.avg), side: "long", asset_class: "us_equity" })));
    if (p === "/v2/account/activities/FILL") {
      const after = url.searchParams.get("page_token");
      const i = after ? state.fills.findIndex((f) => f.id === after) + 1 : 0;
      return send(res, 200, state.fills.slice(i, i + Number(url.searchParams.get("page_size") ?? 100)));
    }
    if (p === "/v2/orders" && req.method === "GET") {
      const all = [...state.orders.values()];
      return send(res, 200, url.searchParams.get("status") === "open" ? all.filter((o) => o.status === "new") : all);
    }
    if (p === "/v2/orders" && req.method === "POST") {
      if (Number(body.qty) * state.price > state.cash && body.side === "buy") return send(res, 403, { message: "insufficient buying power" });
      const now = new Date().toISOString();
      const o: Record<string, unknown> = { id: `ord${++state.seq}`, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, type: body.type, order_type: body.type,
        qty: body.qty, filled_qty: "0", filled_avg_price: null, limit_price: body.limit_price ?? null, stop_price: null, time_in_force: body.time_in_force, status: "new", created_at: now, updated_at: now };
      state.orders.set(String(o.id), o);
      return send(res, 200, o);
    }
    const m = p.match(/^\/v2\/orders\/(.+)$/);
    if (m) {
      const o = state.orders.get(m[1]);
      if (!o) return send(res, 404, { message: "order not found" });
      if (req.method === "DELETE") { if (o.status !== "new") return send(res, 422, { message: "order is not cancelable" }); o.status = "canceled"; return send(res, 204); }
      return send(res, 200, o);
    }
    if (p === "/v2/stocks/snapshots") {
      const out: Record<string, unknown> = {};
      for (const s of url.searchParams.get("symbols")!.split(",")) {
        const t = new Date().toISOString();
        out[s] = { latestTrade: { p: state.price, t }, latestQuote: { bp: state.price - 0.02, ap: state.price + 0.03, t }, dailyBar: { o: 99, h: 101, l: 98, c: state.price, v: 12345, t }, prevDailyBar: { c: 95 } };
      }
      return send(res, 200, out);
    }
    send(res, 404, { message: "not found" });
  });
  return {
    state,
    /** Fill every working market order (what the exchange does a moment later). */
    fillAll: () => { for (const o of state.orders.values()) if (o.status === "new" && o.type === "market") fill(o); },
    start: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

