import type { Broker } from "./brokers/broker.js";
import { multiplier } from "./options/occ.js";
import type { QuoteHub } from "./market/quoteHub.js";
import type { JsonFile, JsonlLog, Storage } from "./storage.js";
import type { Position, Quote } from "./types.js";
import { round2 } from "./util.js";

export interface ProfitGuardSettings {
  enabled: boolean;
  /** Sell when price falls this % from today's high (0.5–50). */
  dropPct: number;
  /**
   * Cushion above cost for the sell floor (0–5%). A market sell fills at the bid and prices
   * can gap between ticks, so a floor exactly at cost would often fill slightly below it.
   */
  floorPct: number;
  /** Tickers excluded from automatic selling (the per-ticker kill-switch toggle). */
  disabledSymbols: string[];
}

interface SymbolState {
  day: string; // local YYYY-MM-DD the peak belongs to
  peak: number; // today's highest price seen while holding
  armed: boolean; // position has been in profit today
  triggered?: number; // ts of the sell we sent (prevents repeats)
}

export interface GuardStatus {
  symbol: string;
  avgCost: number;
  peak: number;
  armed: boolean;
  triggerPrice: number | null; // null until armed
  triggered: boolean;
  enabled: boolean; // per-ticker toggle
}

export interface GuardEvent {
  ts: number;
  symbol: string;
  action: "sell" | "skipped" | "error";
  qty?: number;
  price?: number;
  peak?: number;
  avgCost?: number;
  triggerPrice?: number;
  message: string;
}

const today = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Profit protection ("profit guard"). Runs on the server, on every price tick, so it works
 * with the browser closed.
 *
 * For each held position, per day:
 *   - track today's peak price;
 *   - floor = avgCost × (1 + floorPct%), a small cushion above what you paid;
 *   - the position is "armed" once its bid (the price you could sell at) is above the floor,
 *     i.e. it is genuinely in profit;
 *   - trigger price = max(peak × (1 − dropPct%), floor)
 *     → a 5% pullback from today's high, but never below cost + cushion;
 *   - when an armed position's bid falls to the trigger price, cancel its open sell orders
 *     and sell the whole position at market.
 *
 * A position that never got into profit today is not touched (it has no profit to protect).
 * Decisions use the bid because that is what a market sell fills at. A sudden gap larger
 * than the cushion can still fill below cost: no market order can guarantee a price.
 */
export class ProfitGuard {
  private state: JsonFile<Record<string, SymbolState>>;
  private log: JsonlLog<GuardEvent>;
  private positions = new Map<string, Position>();
  private broker: Broker | null = null;
  private listeners = new Set<(e: GuardEvent) => void>();

  constructor(
    storage: Storage,
    hub: QuoteHub,
    private settings: () => ProfitGuardSettings,
    private canTrade: (b: Broker) => boolean,
  ) {
    this.state = storage.json<Record<string, SymbolState>>("profit-guard.json", {});
    this.log = storage.log<GuardEvent>("profit-guard.log.jsonl");
    hub.onTick((q) => this.onQuote(q));
  }

  onEvent(fn: (e: GuardEvent) => void): void {
    this.listeners.add(fn);
  }

  /** Call when the broker changes or its portfolio changes. */
  async refresh(broker: Broker): Promise<void> {
    this.broker = broker;
    const list = await broker.positions();
    this.positions = new Map(list.map((p) => [p.symbol, p]));
    const st = this.state.get();
    for (const sym of Object.keys(st)) if (!this.positions.has(sym)) delete st[sym];
    this.state.touch();
  }

  status(): GuardStatus[] {
    const { dropPct, floorPct, disabledSymbols } = this.settings();
    const off = new Set(disabledSymbols);
    const day = today();
    return [...this.positions.values()].map((p) => {
      const s = this.state.get()[p.symbol];
      const fresh = s && s.day === day ? s : undefined;
      const armed = !!fresh?.armed;
      return {
        symbol: p.symbol,
        avgCost: p.avgCost,
        peak: fresh?.peak ?? 0,
        armed,
        triggerPrice: armed ? round2(Math.max(fresh!.peak * (1 - dropPct / 100), p.avgCost * (1 + floorPct / 100))) : null,
        triggered: !!fresh?.triggered,
        enabled: !off.has(p.symbol),
      };
    });
  }

  recent(limit = 50): GuardEvent[] {
    return this.log.readAll().slice(-limit).reverse();
  }

  private onQuote(q: Quote): void {
    const pos = this.positions.get(q.symbol);
    if (!pos) return;
    const { enabled, dropPct, floorPct, disabledSymbols } = this.settings();
    const floor = pos.avgCost * (1 + floorPct / 100);
    const day = today(q.ts);
    const all = this.state.get();
    let s = all[q.symbol];
    if (!s || s.day !== day) s = all[q.symbol] = { day, peak: q.last, armed: false };

    let dirty = false;
    if (q.last > s.peak) { s.peak = q.last; dirty = true; }
    if (!s.armed && q.bid > floor) { s.armed = true; dirty = true; }
    if (dirty) this.state.touch();

    // Peak/armed keep being tracked while a ticker is switched off, so re-enabling it later
    // uses today's real high rather than starting over.
    if (!enabled || !s.armed || s.triggered || disabledSymbols.includes(q.symbol)) return;
    const trigger = Math.max(s.peak * (1 - dropPct / 100), floor);
    if (q.bid > trigger) return;

    s.triggered = Date.now();
    this.state.touch();
    void this.sell(pos, q, s.peak, round2(trigger));
  }

  private async sell(pos: Position, q: Quote, peak: number, triggerPrice: number): Promise<void> {
    const b = this.broker;
    const base = { ts: Date.now(), symbol: pos.symbol, peak, avgCost: pos.avgCost, triggerPrice, price: q.bid };
    if (!b) return;
    if (!this.canTrade(b)) {
      this.emit({ ...base, action: "skipped", message: `${pos.symbol} hit its protect price ${triggerPrice}, but live trading is disabled. Not sold.` });
      return;
    }
    try {
      // Re-read the live position: it may have been sold or resized since our cache was built.
      const live = (await b.positions()).find((p) => p.symbol === pos.symbol);
      if (!live || live.qty <= 0) return;
      pos = { ...live };
      // Free up shares held by resting sell orders (e.g. a far-away limit), then sell everything.
      for (const o of await b.orders()) {
        if (o.symbol === pos.symbol && o.side === "sell" && o.status === "open") await b.cancelOrder(o.id);
      }
      const order = await b.placeOrder({ symbol: pos.symbol, side: "sell", qty: pos.qty, type: "market", source: "profit-guard" });
      if (order.status === "rejected") throw new Error(order.reason ?? "rejected");
      const pnl = order.avgFillPrice !== undefined ? round2((order.avgFillPrice - pos.avgCost) * pos.qty * multiplier(pos.symbol)) : undefined;
      this.emit({
        ...base, action: "sell", qty: pos.qty, price: order.avgFillPrice ?? q.bid,
        message: `Profit guard sold ${pos.qty} ${pos.symbol}` +
          (order.avgFillPrice !== undefined ? ` @ ${order.avgFillPrice} (P&L ${pnl! >= 0 ? "+" : ""}${pnl})` : " (market order sent)") +
          ` after a pullback from today's high ${peak}.`,
      });
    } catch (err) {
      // Allow a retry on the next tick.
      const s = this.state.get()[pos.symbol];
      if (s) s.triggered = undefined;
      this.emit({ ...base, action: "error", message: `Profit guard could not sell ${pos.symbol}: ${(err as Error).message}` });
    }
  }

  private emit(e: GuardEvent): void {
    this.log.append(e);
    for (const fn of this.listeners) fn(e);
  }
}
