import type { Quote, Instrument } from "../types.js";
import type { MarketDataProvider } from "./provider.js";
import { search, seedPrice } from "./catalog.js";

export interface SimulatedOptions {
  tickMs: number; // how often prices move
  volatility: number; // per-tick std-dev of returns (e.g. 0.0006 = 6bp)
}

/**
 * Offline random-walk market. Each symbol keeps a fixed "previous close" for the session
 * and wanders around it, so % change, day high/low and P&L all behave plausibly.
 * Not real data: it exists so the whole app works with no API keys.
 */
export class SimulatedProvider implements MarketDataProvider {
  readonly name = "simulated";
  private quotes = new Map<string, Quote>();
  private active: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private onQuotes: ((q: Quote[]) => void) | null = null;

  constructor(private opts: SimulatedOptions) {}

  start(onQuotes: (quotes: Quote[]) => void): void {
    this.onQuotes = onQuotes;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSymbols(symbols: string[]): void {
    this.active = symbols;
    for (const s of symbols) this.ensure(s);
  }

  async snapshot(symbols: string[]): Promise<Quote[]> {
    return symbols.map((s) => ({ ...this.ensure(s) }));
  }

  async search(query: string): Promise<Instrument[]> {
    return search(query);
  }

  private ensure(symbol: string): Quote {
    let q = this.quotes.get(symbol);
    if (!q) {
      const prevClose = seedPrice(symbol);
      // Start somewhere within ±2% of the previous close.
      const last = round(prevClose * (1 + (Math.random() - 0.5) * 0.04));
      q = { symbol, last, prevClose, high: Math.max(last, prevClose), low: Math.min(last, prevClose),
        volume: Math.floor(Math.random() * 1e6), ts: Date.now(), ...spread(last) };
      this.quotes.set(symbol, q);
    }
    return q;
  }

  private tick(): void {
    if (!this.onQuotes || this.active.length === 0) return;
    const now = Date.now();
    const changed: Quote[] = [];
    for (const symbol of this.active) {
      if (Math.random() > 0.55) continue; // not every symbol trades every tick
      const q = this.ensure(symbol);
      // Gaussian step with gentle mean reversion toward prevClose so prices don't drift away forever.
      const drift = ((q.prevClose - q.last) / q.prevClose) * 0.002;
      const last = round(Math.max(0.01, q.last * (1 + drift + gaussian() * this.opts.volatility)));
      if (last === q.last) continue;
      q.last = last;
      const s = spread(last);
      q.bid = s.bid;
      q.ask = s.ask;
      if (last > q.high) q.high = last;
      if (last < q.low) q.low = last;
      q.volume += Math.floor(Math.random() * 500) + 1;
      q.ts = now;
      changed.push({ ...q });
    }
    if (changed.length) this.onQuotes(changed);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

function spread(last: number): { bid: number; ask: number } {
  const half = Math.max(0.01, round(last * 0.00005));
  return { bid: round(last - half), ask: round(last + half) };
}

function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}
