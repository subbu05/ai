import type { Account, Fill, Order, OrderRequest, Position, Quote } from "../types.js";
import type { Broker } from "./broker.js";
import { Emitter } from "./broker.js";
import type { QuoteHub } from "../market/quoteHub.js";
import type { JsonFile, JsonlLog, Storage } from "../storage.js";
import { HttpError, newId, normalizeSymbol, round2, round6 } from "../util.js";

interface PaperState {
  cash: number;
  startingCash: number;
  realizedPnl: number;
}

const ORDER_TYPES = new Set(["market", "limit", "stop", "stop_limit"]);
const MAX_CLOSED_ORDERS = 500;

/**
 * Simulated broker: fills against live quotes from the QuoteHub.
 *
 * - market: buys fill at the ask, sells at the bid, immediately.
 * - limit: rests until the ask <= limit (buy) / bid >= limit (sell).
 * - stop / stop_limit: trigger when last crosses the stop, then behave as market / limit.
 * - Long-only: sells can't exceed shares held minus shares already committed to open sells.
 * - Buys can't exceed buying power (cash minus cash reserved by open buy orders).
 *
 * Open orders are indexed by symbol, so each tick only checks orders for that symbol.
 * State is persisted to data/paper/*.json; every fill is appended to data/paper/fills.jsonl.
 */
export class PaperBroker extends Emitter implements Broker {
  readonly id = "paper";
  readonly displayName = "Paper (simulated)";
  readonly live = false;

  private state: JsonFile<PaperState>;
  private positionsFile: JsonFile<Record<string, Position>>;
  private ordersFile: JsonFile<Order[]>;
  private fillsLog: JsonlLog<Fill>;
  private fillsCache: Fill[];
  private openBySymbol = new Map<string, Set<Order>>();
  private unsubscribe: (() => void) | null = null;

  constructor(storage: Storage, private hub: QuoteHub, startingCash: number) {
    super();
    this.state = storage.json<PaperState>("paper/account.json", { cash: startingCash, startingCash, realizedPnl: 0 });
    this.positionsFile = storage.json<Record<string, Position>>("paper/positions.json", {});
    this.ordersFile = storage.json<Order[]>("paper/orders.json", []);
    this.fillsLog = storage.log<Fill>("paper/fills.jsonl");
    // The log is append-only; a reset writes a marker, and only fills after the last marker count.
    const all = this.fillsLog.readAll() as (Fill & { reset?: boolean })[];
    let start = 0;
    for (let i = all.length - 1; i >= 0; i--) if (all[i].reset) { start = i + 1; break; }
    this.fillsCache = all.slice(start);
  }

  async init(): Promise<void> {
    for (const o of this.ordersFile.get()) if (o.status === "open") this.index(o);
    this.unsubscribe = this.hub.onTick((q) => this.onQuote(q));
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
  }

  async account(): Promise<Account> {
    const s = this.state.get();
    return {
      broker: this.id,
      cash: round2(s.cash),
      buyingPower: round2(s.cash - this.reservedCash()),
      startingCash: s.startingCash,
      realizedPnl: round2(s.realizedPnl),
    };
  }

  async positions(): Promise<Position[]> {
    return Object.values(this.positionsFile.get());
  }

  async orders(): Promise<Order[]> {
    return [...this.ordersFile.get()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async fills(limit = 500): Promise<Fill[]> {
    return this.fillsCache.slice(-limit).reverse();
  }

  watchedSymbols(): string[] {
    return [...new Set([...Object.keys(this.positionsFile.get()), ...this.openBySymbol.keys()])];
  }

  async placeOrder(req: OrderRequest): Promise<Order> {
    const symbol = normalizeSymbol(req.symbol);
    if (!symbol) throw new HttpError(400, "Invalid symbol");
    if (req.side !== "buy" && req.side !== "sell") throw new HttpError(400, "side must be buy or sell");
    if (!ORDER_TYPES.has(req.type)) throw new HttpError(400, "Invalid order type");
    const qty = round6(Number(req.qty));
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, "Quantity must be greater than 0");
    const needsLimit = req.type === "limit" || req.type === "stop_limit";
    const needsStop = req.type === "stop" || req.type === "stop_limit";
    const limitPrice = needsLimit ? round2(Number(req.limitPrice)) : undefined;
    const stopPrice = needsStop ? round2(Number(req.stopPrice)) : undefined;
    if (needsLimit && !(limitPrice! > 0)) throw new HttpError(400, "Limit price is required");
    if (needsStop && !(stopPrice! > 0)) throw new HttpError(400, "Stop price is required");

    const [quote] = await this.hub.getMany([symbol]);
    if (!quote) throw new HttpError(400, `No quote for ${symbol}`);

    const now = Date.now();
    const order: Order = {
      id: newId("ord"), symbol, side: req.side, qty, type: req.type, limitPrice, stopPrice,
      tif: req.tif === "gtc" ? "gtc" : "day", status: "open", filledQty: 0,
      createdAt: now, updatedAt: now, broker: this.id,
    };

    const problem = this.checkFunds(order, quote);
    if (problem) {
      order.status = "rejected";
      order.reason = problem;
      this.record(order);
      this.emit("order", order);
      return order;
    }

    this.record(order);
    this.index(order);
    this.tryFill(order, quote);
    if (order.status === "open") this.emit("order", order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<Order> {
    const order = this.ordersFile.get().find((o) => o.id === orderId);
    if (!order) throw new HttpError(404, "Order not found");
    if (order.status !== "open") throw new HttpError(409, `Order is already ${order.status}`);
    order.status = "cancelled";
    order.updatedAt = Date.now();
    this.unindex(order);
    this.ordersFile.touch();
    this.emit("order", order);
    this.emit("portfolio");
    return order;
  }

  /** Wipe the paper account back to starting cash. */
  reset(startingCash?: number): void {
    const cash = startingCash ?? this.state.get().startingCash;
    this.state.set({ cash, startingCash: cash, realizedPnl: 0 });
    this.positionsFile.set({});
    this.ordersFile.set([]);
    this.openBySymbol.clear();
    this.fillsLog.append({ id: newId("reset"), orderId: "", symbol: "", side: "buy", qty: 0, price: 0, ts: Date.now(), realizedPnl: 0, reset: true } as Fill & { reset: boolean });
    this.fillsCache = [];
    this.emit("portfolio");
  }

  // -------------------------------------------------------------------------------------

  private checkFunds(order: Order, quote: Quote): string | null {
    if (order.side === "sell") {
      const held = this.positionsFile.get()[order.symbol]?.qty ?? 0;
      const committed = this.committedSellQty(order.symbol);
      if (order.qty > round6(held - committed) + 1e-9) {
        return `Insufficient shares: hold ${held}, ${committed} already in open sell orders`;
      }
      return null;
    }
    const cost = order.qty * this.reservePrice(order, quote);
    const bp = this.state.get().cash - this.reservedCash();
    return cost > bp + 1e-9 ? `Insufficient buying power: need $${round2(cost)}, have $${round2(bp)}` : null;
  }

  private reservePrice(o: Order, q?: Quote): number {
    return o.limitPrice ?? o.stopPrice ?? q?.ask ?? this.hub.get(o.symbol)?.ask ?? 0;
  }

  private reservedCash(): number {
    let sum = 0;
    for (const set of this.openBySymbol.values()) {
      for (const o of set) if (o.side === "buy") sum += (o.qty - o.filledQty) * this.reservePrice(o);
    }
    return sum;
  }

  private committedSellQty(symbol: string): number {
    let sum = 0;
    for (const o of this.openBySymbol.get(symbol) ?? []) if (o.side === "sell") sum += o.qty - o.filledQty;
    return round6(sum);
  }

  private onQuote(q: Quote): void {
    const set = this.openBySymbol.get(q.symbol);
    if (!set) return;
    for (const o of [...set]) this.tryFill(o, q);
  }

  private tryFill(o: Order, q: Quote): void {
    if (o.status !== "open") return;
    if ((o.type === "stop" || o.type === "stop_limit") && !o.triggered) {
      const hit = o.side === "buy" ? q.last >= o.stopPrice! : q.last <= o.stopPrice!;
      if (!hit) return;
      o.triggered = true;
      o.updatedAt = q.ts;
      this.ordersFile.touch();
    }
    let price: number | null = null;
    const marketable = o.type === "market" || o.type === "stop";
    if (o.side === "buy") {
      if (marketable || q.ask <= o.limitPrice!) price = q.ask;
    } else if (marketable || q.bid >= o.limitPrice!) {
      price = q.bid;
    }
    if (price === null) return;

    // Funds can change between placement and a later fill (e.g. stop orders reserve at stop price).
    if (o.side === "buy" && o.qty * price > this.state.get().cash + 1e-9) {
      o.status = "rejected";
      o.reason = "Insufficient cash at fill time";
      o.updatedAt = Date.now();
      this.unindex(o);
      this.ordersFile.touch();
      this.emit("order", o);
      return;
    }
    this.execute(o, price);
  }

  private execute(o: Order, price: number): void {
    const now = Date.now();
    const positions = this.positionsFile.get();
    const state = this.state.get();
    const qty = o.qty - o.filledQty;
    let realized = 0;

    const pos = positions[o.symbol];
    if (o.side === "buy") {
      state.cash -= qty * price;
      if (pos) {
        const newQty = round6(pos.qty + qty);
        pos.avgCost = (pos.qty * pos.avgCost + qty * price) / newQty;
        pos.qty = newQty;
      } else {
        positions[o.symbol] = { symbol: o.symbol, qty, avgCost: price, realizedPnl: 0, openedAt: now };
      }
    } else {
      // Long-only, so pos must exist (checked at placement).
      realized = round2((price - pos!.avgCost) * qty);
      state.cash += qty * price;
      state.realizedPnl += realized;
      pos!.realizedPnl = round2(pos!.realizedPnl + realized);
      pos!.qty = round6(pos!.qty - qty);
      if (pos!.qty <= 1e-9) delete positions[o.symbol];
    }
    state.cash = round6(state.cash);

    o.filledQty = o.qty;
    o.avgFillPrice = price;
    o.status = "filled";
    o.updatedAt = now;
    this.unindex(o);

    const fill: Fill = { id: newId("fill"), orderId: o.id, symbol: o.symbol, side: o.side, qty, price, ts: now, realizedPnl: realized };
    this.fillsLog.append(fill);
    this.fillsCache.push(fill);

    this.state.touch();
    this.positionsFile.touch();
    this.ordersFile.touch();
    this.emit("order", o);
    this.emit("portfolio");
  }

  private record(o: Order): void {
    const list = this.ordersFile.get();
    list.push(o);
    // Keep all open orders, trim old closed ones.
    if (list.length > MAX_CLOSED_ORDERS * 1.2) {
      const open = list.filter((x) => x.status === "open");
      const closed = list.filter((x) => x.status !== "open").slice(-MAX_CLOSED_ORDERS);
      this.ordersFile.set([...closed, ...open].sort((a, b) => a.createdAt - b.createdAt));
    } else {
      this.ordersFile.touch();
    }
  }

  private index(o: Order): void {
    let set = this.openBySymbol.get(o.symbol);
    if (!set) this.openBySymbol.set(o.symbol, (set = new Set()));
    set.add(o);
  }

  private unindex(o: Order): void {
    const set = this.openBySymbol.get(o.symbol);
    if (!set) return;
    set.delete(o);
    if (set.size === 0) this.openBySymbol.delete(o.symbol);
  }
}
