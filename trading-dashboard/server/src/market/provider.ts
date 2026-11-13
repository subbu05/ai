import type { Instrument, Quote } from "../types.js";

/**
 * A source of live quotes. The QuoteHub tells the provider which symbols are needed
 * (union of all widgets, positions and open orders) and receives batches of updates.
 *
 * To plug in real data (broker feed, Polygon, Finnhub, Alpaca, IEX...), implement this
 * interface and register it in market/index.ts.
 */
export interface MarketDataProvider {
  readonly name: string;
  start(onQuotes: (quotes: Quote[]) => void): void;
  stop(): void;
  /** Full set of symbols that should be streaming. Called whenever it changes. */
  setSymbols(symbols: string[]): void;
  /** One-shot snapshot (used when a symbol is first requested). */
  snapshot(symbols: string[]): Promise<Quote[]>;
  search(query: string): Promise<Instrument[]>;
}
