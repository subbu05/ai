import type { Instrument, Quote } from "../types.js";
import type { MarketDataProvider } from "./provider.js";

/** Lets the app swap the data source at runtime (e.g. to Alpaca once keys are saved) without a restart. */
export class SwitchableProvider implements MarketDataProvider {
  private onQuotes: ((q: Quote[]) => void) | null = null;
  private symbols: string[] = [];

  constructor(private inner: MarketDataProvider) {}

  get name(): string {
    return this.inner.name;
  }

  swap(next: MarketDataProvider): void {
    if (next === this.inner) return;
    const running = this.onQuotes;
    if (running) this.inner.stop();
    this.inner = next;
    if (running) {
      next.start(running);
      next.setSymbols(this.symbols);
    }
  }

  start(onQuotes: (quotes: Quote[]) => void): void {
    this.onQuotes = onQuotes;
    this.inner.start(onQuotes);
  }
  stop(): void {
    this.onQuotes = null;
    this.inner.stop();
  }
  setSymbols(symbols: string[]): void {
    this.symbols = symbols;
    this.inner.setSymbols(symbols);
  }
  snapshot(symbols: string[]): Promise<Quote[]> {
    return this.inner.snapshot(symbols);
  }
  search(query: string): Promise<Instrument[]> {
    return this.inner.search(query);
  }
}
