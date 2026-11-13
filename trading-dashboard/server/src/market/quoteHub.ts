import type { Quote } from "../types.js";
import type { MarketDataProvider } from "./provider.js";

type TickListener = (q: Quote) => void;
type FlushListener = (batch: Quote[]) => void;

/**
 * Central quote cache + fan-out.
 *
 * - Demand is tracked per named source ("widgets", "positions", "orders", "client:<id>").
 *   The provider only streams the union, so unused symbols cost nothing.
 * - Every raw tick goes to tick listeners synchronously (the broker uses this to match
 *   resting limit/stop orders with no added latency).
 * - UI fan-out is coalesced: changed symbols are collected into a dirty set and flushed
 *   every `flushMs`, so a symbol that ticks 10x in a window is sent once (latest value).
 */
export class QuoteHub {
  private quotes = new Map<string, Quote>();
  private demand = new Map<string, Set<string>>();
  private union = new Set<string>();
  private dirty = new Set<string>();
  private tickListeners = new Set<TickListener>();
  private flushListeners = new Set<FlushListener>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private provider: MarketDataProvider, private flushMs: number) {}

  get providerName(): string {
    return this.provider.name;
  }

  start(): void {
    this.provider.start((batch) => this.ingest(batch));
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.provider.stop();
    if (this.timer) clearInterval(this.timer);
  }

  get(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  /** Returns quotes for all symbols, fetching a snapshot for any not yet cached. */
  async getMany(symbols: string[]): Promise<Quote[]> {
    const missing = symbols.filter((s) => !this.quotes.has(s));
    if (missing.length) {
      for (const q of await this.provider.snapshot(missing)) this.quotes.set(q.symbol, q);
    }
    return symbols.map((s) => this.quotes.get(s)).filter((q): q is Quote => !!q);
  }

  setDemand(source: string, symbols: Iterable<string>): void {
    const set = new Set(symbols);
    if (set.size === 0) this.demand.delete(source);
    else this.demand.set(source, set);
    const next = new Set<string>();
    for (const s of this.demand.values()) for (const sym of s) next.add(sym);
    if (next.size === this.union.size && [...next].every((s) => this.union.has(s))) return;
    this.union = next;
    this.provider.setSymbols([...next]);
  }

  onTick(fn: TickListener): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  onFlush(fn: FlushListener): () => void {
    this.flushListeners.add(fn);
    return () => this.flushListeners.delete(fn);
  }

  /** Exposed for providers that push data and for tests. */
  ingest(batch: Quote[]): void {
    for (const q of batch) {
      this.quotes.set(q.symbol, q);
      this.dirty.add(q.symbol);
      for (const fn of this.tickListeners) fn(q);
    }
  }

  private flush(): void {
    if (this.dirty.size === 0 || this.flushListeners.size === 0) {
      this.dirty.clear();
      return;
    }
    const batch: Quote[] = [];
    for (const s of this.dirty) {
      const q = this.quotes.get(s);
      if (q) batch.push(q);
    }
    this.dirty.clear();
    for (const fn of this.flushListeners) fn(batch);
  }
}
