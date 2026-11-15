import type { Account, Fill, Order, OrderRequest, OrderSource, OrderStatus, OrderType, Position, TimeInForce } from "../types.js";
import type { Broker } from "./broker.js";
import { Emitter } from "./broker.js";
import type { CredentialField } from "./live.js";
import { HttpError, normalizeSymbol, round2, round6 } from "../util.js";
import { isOption } from "../options/occ.js";

/**
 * Alpaca (https://alpaca.markets) Trading API v2: stocks, ETFs and options.
 *
 * - Paper and live use the same API on different hosts, with different key pairs.
 * - Auth is two headers (APCA-API-KEY-ID / APCA-API-SECRET-KEY); keys stay on the server.
 * - State is kept in sync by polling: open orders every 2 s, account + positions every 10 s,
 *   and new fills whenever an order changes. That keeps us well inside Alpaca's 200 req/min.
 * - Orders this app places carry a client_order_id prefix so their source (manual, profit
 *   guard, kill switch) survives a restart.
 */

export type AlpacaMode = "paper" | "live";

export const ALPACA_URLS = {
  paper: "https://paper-api.alpaca.markets",
  live: "https://api.alpaca.markets",
  data: "https://data.alpaca.markets",
};

export const ALPACA_FIELDS: CredentialField[] = [
  { key: "keyId", label: "API key ID", secret: false, required: true, help: "Alpaca dashboard → API Keys. Paper and live accounts have different keys." },
  { key: "secretKey", label: "Secret key", secret: true, required: true },
];

interface AOrder {
  id: string; client_order_id: string; symbol: string; side: string; type: string; order_type?: string;
  qty: string | null; filled_qty: string; filled_avg_price: string | null; limit_price: string | null; stop_price: string | null;
  time_in_force: string; status: string; created_at: string; updated_at: string | null; asset_class?: string;
}
interface AActivity { id: string; activity_type: string; transaction_time: string; price: string; qty: string; side: string; symbol: string; order_id: string }
interface APosition { symbol: string; qty: string; avg_entry_price: string; side: string; asset_class?: string }
interface AAccount { cash: string; buying_power: string; equity: string; last_equity: string; status: string; trading_blocked: boolean; account_blocked: boolean; currency: string }

const STATUS: Record<string, OrderStatus> = {
  new: "open", accepted: "open", pending_new: "pending", accepted_for_bidding: "open", partially_filled: "open",
  pending_replace: "open", pending_cancel: "open", calculated: "open", held: "open", stopped: "open", suspended: "open", done_for_day: "open",
  filled: "filled", canceled: "cancelled", expired: "cancelled", replaced: "cancelled", rejected: "rejected",
};
const TERMINAL = new Set<OrderStatus>(["filled", "cancelled", "rejected"]);
const SOURCE_PREFIX: Record<string, OrderSource> = { "td-m-": "manual", "td-pg-": "profit-guard", "td-ks-": "kill-switch" };

const num = (s: string | null | undefined): number | undefined => {
  if (s === null || s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

export interface AlpacaOptions {
  /** Override hosts (tests, proxies). */
  tradingUrl?: string;
  fetch?: typeof fetch;
  orderPollMs?: number;
  accountPollMs?: number;
}

export class AlpacaBroker extends Emitter implements Broker {
  readonly id: "alpaca-paper" | "alpaca-live";
  readonly displayName: string;
  readonly live: boolean;

  private base: string;
  private fetchFn: typeof fetch;
  private headers: Record<string, string>;
  private ordersById = new Map<string, Order>();
  private fillsList: Fill[] = []; // chronological
  private lastFillId: string | undefined;
  private acct: AAccount | null = null;
  private pos: APosition[] = [];
  private timers: NodeJS.Timeout[] = [];
  private polling = false;
  private disposed = false;
  private lastError = 0;
  private prevFilled = new Map<string, number>();

  constructor(private mode: AlpacaMode, private creds: Record<string, string>, private opts: AlpacaOptions = {}) {
    super();
    this.id = mode === "live" ? "alpaca-live" : "alpaca-paper";
    this.displayName = mode === "live" ? "Alpaca (live)" : "Alpaca (paper)";
    this.live = mode === "live";
    this.base = (opts.tradingUrl ?? process.env.TD_ALPACA_TRADING_URL ?? ALPACA_URLS[mode]).replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.headers = { "APCA-API-KEY-ID": creds.keyId ?? "", "APCA-API-SECRET-KEY": creds.secretKey ?? "" };
  }

  // ------------------------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    const missing = ALPACA_FIELDS.filter((f) => f.required && !this.creds[f.key]).map((f) => f.label);
    if (missing.length) throw new HttpError(400, `${this.displayName}: missing credentials: ${missing.join(", ")}`);
    const acct = await this.call<AAccount>("GET", "/v2/account");
    if (acct.account_blocked) throw new HttpError(400, `${this.displayName}: this account is blocked by Alpaca`);
    if (acct.currency && acct.currency !== "USD") throw new HttpError(400, `${this.displayName}: only USD accounts are supported`);
    this.acct = acct;
    this.pos = await this.call<APosition[]>("GET", "/v2/positions");
    await this.syncFills();
    for (const o of await this.call<AOrder[]>("GET", "/v2/orders?status=all&limit=500&direction=desc&nested=false")) {
      const order = this.mapOrder(o);
      this.ordersById.set(order.id, order);
      this.prevFilled.set(order.id, order.filledQty);
    }
    const orderPoll = setInterval(() => void this.pollOrders(), this.opts.orderPollMs ?? 2000);
    const acctPoll = setInterval(() => void this.pollAccount(), this.opts.accountPollMs ?? 10_000);
    orderPoll.unref?.();
    acctPoll.unref?.();
    this.timers.push(orderPoll, acctPoll);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ------------------------------------------------------------------------------- reads

  async account(): Promise<Account> {
    const a = this.acct;
    return {
      broker: this.id,
      cash: round2(num(a?.cash) ?? 0),
      buyingPower: round2(num(a?.buying_power) ?? 0),
      // Alpaca has no "starting cash" (deposits come and go): 0 tells the UI to show
      // realized + unrealized as total P&L instead of equity minus a starting balance.
      startingCash: 0,
      realizedPnl: round2(this.fillsList.reduce((s, f) => s + f.realizedPnl, 0)),
    };
  }

  async positions(): Promise<Position[]> {
    const realized = new Map<string, number>();
    const opened = new Map<string, number>();
    const held = new Map<string, number>();
    for (const f of this.fillsList) {
      realized.set(f.symbol, (realized.get(f.symbol) ?? 0) + f.realizedPnl);
      const before = held.get(f.symbol) ?? 0;
      const after = before + (f.side === "buy" ? f.qty : -f.qty);
      if (before <= 1e-9 && after > 1e-9) opened.set(f.symbol, f.ts);
      held.set(f.symbol, after);
    }
    return this.pos
      .filter((p) => p.side !== "short" && (num(p.qty) ?? 0) > 0) // the dashboard is long-only
      .map((p) => ({
        symbol: p.symbol,
        qty: round6(num(p.qty) ?? 0),
        avgCost: round6(num(p.avg_entry_price) ?? 0),
        realizedPnl: round2(realized.get(p.symbol) ?? 0),
        openedAt: opened.get(p.symbol) ?? Date.now(),
      }));
  }

  async orders(): Promise<Order[]> {
    return [...this.ordersById.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
  }

  async fills(limit = 500): Promise<Fill[]> {
    return this.fillsList.slice(-limit).reverse();
  }

  watchedSymbols(): string[] {
    const s = new Set(this.pos.map((p) => p.symbol));
    for (const o of this.ordersById.values()) if (!TERMINAL.has(o.status)) s.add(o.symbol);
    return [...s];
  }

  // ------------------------------------------------------------------------------- trading

  async placeOrder(req: OrderRequest): Promise<Order> {
    const symbol = normalizeSymbol(req.symbol);
    if (!symbol) throw new HttpError(400, "Invalid symbol");
    if (req.side !== "buy" && req.side !== "sell") throw new HttpError(400, "side must be buy or sell");
    if (!["market", "limit", "stop", "stop_limit"].includes(req.type)) throw new HttpError(400, "Unsupported order type");
    const qty = Number(req.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, "Quantity must be positive");
    const option = isOption(symbol);
    if (option && !Number.isInteger(qty)) throw new HttpError(400, "Options trade in whole contracts");
    if (option && (req.type === "stop" || req.type === "stop_limit")) throw new HttpError(400, "Stop orders aren't supported for options");
    if (req.side === "sell") {
      // Long-only: never let a sell open a short position.
      const held = num(this.pos.find((p) => p.symbol === symbol && p.side !== "short")?.qty) ?? 0;
      if (qty > held + 1e-9) throw new HttpError(400, `You hold ${held} ${symbol}; selling more would open a short position`);
    }
    const price = (v: unknown, name: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${name} must be a positive number`);
      return String(round2(n) === n ? n : Number(n.toFixed(n < 1 ? 4 : 2)));
    };
    const tif: TimeInForce = option ? "day" : (req.tif ?? "day");
    const prefix = req.source === "profit-guard" ? "td-pg-" : req.source === "kill-switch" ? "td-ks-" : "td-m-";
    const body: Record<string, string> = {
      symbol, side: req.side, type: req.type, qty: String(qty), time_in_force: tif,
      client_order_id: `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    };
    if (req.type === "limit" || req.type === "stop_limit") body.limit_price = price(req.limitPrice, "Limit price");
    if (req.type === "stop" || req.type === "stop_limit") body.stop_price = price(req.stopPrice, "Stop price");

    let o: AOrder;
    try {
      o = await this.call<AOrder>("POST", "/v2/orders", body);
    } catch (err) {
      // Alpaca refused the order (buying power, market closed for this type, unknown symbol...):
      // return it as a rejected order so the UI shows the reason.
      if (err instanceof HttpError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 401) {
        const now = Date.now();
        const rejected: Order = {
          id: `rejected-${now}`, symbol, side: req.side, qty, type: req.type, tif, status: "rejected", filledQty: 0,
          limitPrice: req.limitPrice, stopPrice: req.stopPrice, reason: err.message, createdAt: now, updatedAt: now,
          broker: this.id, source: req.source ?? "manual",
        };
        this.emit("order", rejected);
        return rejected;
      }
      throw err;
    }
    const order = this.mapOrder(o);
    this.ordersById.set(order.id, order);
    this.emit("order", order);
    void this.pollOrders(); // market orders usually fill within a second
    return order;
  }

  async cancelOrder(orderId: string): Promise<Order> {
    if (!/^[\w-]{1,64}$/.test(orderId)) throw new HttpError(400, "Invalid order id");
    try {
      await this.call("DELETE", `/v2/orders/${orderId}`);
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 422)) throw err; // 422: already filled/cancelled
    }
    const order = this.mapOrder(await this.call<AOrder>("GET", `/v2/orders/${orderId}`));
    this.ordersById.set(order.id, order);
    this.emit("order", order);
    return order;
  }

  // ------------------------------------------------------------------------------- sync

  private async pollOrders(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const open = await this.call<AOrder[]>("GET", "/v2/orders?status=open&limit=500&nested=false");
      const openIds = new Set(open.map((o) => o.id));
      const changed: Order[] = [];
      for (const raw of open) {
        const o = this.mapOrder(raw);
        const prev = this.ordersById.get(o.id);
        if (!prev || prev.updatedAt !== o.updatedAt || prev.filledQty !== o.filledQty || prev.status !== o.status) changed.push(o);
        this.ordersById.set(o.id, o);
      }
      // Orders we thought were working but Alpaca no longer lists as open: fetch their final state.
      for (const prev of [...this.ordersById.values()]) {
        if (TERMINAL.has(prev.status) || openIds.has(prev.id) || prev.id.startsWith("rejected-")) continue;
        const o = this.mapOrder(await this.call<AOrder>("GET", `/v2/orders/${prev.id}`));
        this.ordersById.set(o.id, o);
        changed.push(o);
      }
      if (!changed.length) return;
      const filled = changed.some((o) => o.filledQty > (this.prevFilled.get(o.id) ?? 0));
      for (const o of changed) this.prevFilled.set(o.id, o.filledQty);
      if (filled) {
        await this.syncFills();
        await this.refreshAccount();
      }
      for (const o of changed) this.emit("order", o);
      if (filled) this.emit("portfolio");
    } catch (err) {
      this.report(err);
    } finally {
      this.polling = false;
    }
  }
  private async pollAccount(): Promise<void> {
    if (this.disposed) return;
    try {
      const before = JSON.stringify([this.acct?.cash, this.pos.map((p) => [p.symbol, p.qty, p.avg_entry_price])]);
      await this.refreshAccount();
      const after = JSON.stringify([this.acct?.cash, this.pos.map((p) => [p.symbol, p.qty, p.avg_entry_price])]);
      if (before !== after) {
        await this.syncFills(); // e.g. a trade placed in Alpaca's own app
        this.emit("portfolio");
      }
    } catch (err) {
      this.report(err);
    }
  }

  private async refreshAccount(): Promise<void> {
    const [acct, pos] = await Promise.all([this.call<AAccount>("GET", "/v2/account"), this.call<APosition[]>("GET", "/v2/positions")]);
    this.acct = acct;
    this.pos = pos;
  }

  /** Pull fill activities after the last one we have (all of them on first run, capped). */
  private async syncFills(): Promise<void> {
    const fresh: AActivity[] = [];
    let token = this.lastFillId;
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ direction: "asc", page_size: "100" });
      if (token) q.set("page_token", token);
      const batch = await this.call<AActivity[]>("GET", `/v2/account/activities/FILL?${q}`);
      if (!batch.length) break;
      fresh.push(...batch);
      token = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }
    if (!fresh.length) return;
    this.lastFillId = token;
    const all = [...this.fillsList.map((f) => ({ ...f })), ...fresh.map((a) => this.mapFill(a))];
    this.fillsList = withRealizedPnl(all);
  }

  private mapFill(a: AActivity): Fill {
    return {
      id: a.id, orderId: a.order_id, symbol: a.symbol, side: a.side === "buy" ? "buy" : "sell",
      qty: num(a.qty) ?? 0, price: num(a.price) ?? 0, ts: Date.parse(a.transaction_time) || Date.now(), realizedPnl: 0,
    };
  }

  private mapOrder(o: AOrder): Order {
    const type = (o.order_type ?? o.type) as string;
    const mappedType: OrderType = type === "limit" || type === "stop" || type === "stop_limit" ? type : type === "trailing_stop" ? "stop" : "market";
    const prefix = Object.keys(SOURCE_PREFIX).find((p) => o.client_order_id?.startsWith(p));
    const status = STATUS[o.status] ?? "open";
    return {
      id: o.id, symbol: o.symbol, side: o.side === "buy" ? "buy" : "sell", type: mappedType,
      qty: num(o.qty) ?? num(o.filled_qty) ?? 0, filledQty: num(o.filled_qty) ?? 0,
      avgFillPrice: num(o.filled_avg_price), limitPrice: num(o.limit_price), stopPrice: num(o.stop_price),
      tif: o.time_in_force === "gtc" ? "gtc" : "day", status,
      reason: status === "rejected" ? "Rejected by Alpaca" : o.status === "expired" ? "Expired" : undefined,
      createdAt: Date.parse(o.created_at) || Date.now(), updatedAt: Date.parse(o.updated_at ?? o.created_at) || Date.now(),
      broker: this.id, source: prefix ? SOURCE_PREFIX[prefix] : undefined,
    };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method,
        headers: { ...this.headers, ...(body ? { "content-type": "application/json" } : {}), accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new HttpError(502, `${this.displayName}: can't reach Alpaca (${(err as Error).message})`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!res.ok) {
      const msg = (data as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      // 401 = bad keys. A 403 on a read also means the keys lack access; on an order it is
      // Alpaca refusing that order (e.g. insufficient buying power), handled below.
      if (res.status === 401 || (res.status === 403 && method === "GET")) {
        throw new HttpError(401, `${this.displayName}: Alpaca rejected the API keys (${msg}). Check that they're ${this.mode} keys.`);
      }
      throw new HttpError(res.status >= 500 ? 502 : res.status === 403 ? 422 : res.status, `Alpaca: ${msg}`);
    }
    return data as T;
  }

  private report(err: unknown): void {
    // Network blips are expected; log at most once a minute.
    if (Date.now() - this.lastError > 60_000) {
      this.lastError = Date.now();
      console.error(`${this.displayName} sync: ${(err as Error).message}`);
    }
  }
}

/** Throws a clear error unless Alpaca accepts these keys (one GET /v2/account). */
export async function verifyAlpacaKeys(mode: AlpacaMode, creds: Record<string, string>, opts: AlpacaOptions = {}): Promise<void> {
  const b = new AlpacaBroker(mode, creds, opts);
  await (b as unknown as { call: (m: string, p: string) => Promise<unknown> }).call("GET", "/v2/account");
}

/** Realized P&L per fill by replaying fills with average cost (the same method the paper broker uses). */
export function withRealizedPnl(fills: Fill[]): Fill[] {
  const sorted = [...fills].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const book = new Map<string, { qty: number; cost: number }>();
  for (const f of sorted) {
    const m = isOption(f.symbol) ? 100 : 1;
    const b = book.get(f.symbol) ?? { qty: 0, cost: 0 };
    if (f.side === "buy") {
      b.cost += f.qty * f.price;
      b.qty += f.qty;
      f.realizedPnl = 0;
    } else {
      const closing = Math.min(f.qty, Math.max(0, b.qty));
      const avg = b.qty > 0 ? b.cost / b.qty : 0;
      f.realizedPnl = round2(closing * (f.price - avg) * m);
      b.cost -= closing * avg;
      b.qty -= closing;
    }
    book.set(f.symbol, b);
  }
  return sorted;
}
