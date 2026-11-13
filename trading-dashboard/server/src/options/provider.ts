import type { Instrument, Quote } from "../types.js";
import type { MarketDataProvider } from "../market/provider.js";
import { parseOcc, type OptionContract } from "./occ.js";
import type { SimulatedOptionModel } from "./chain.js";

/**
 * Wraps a stock/ETF data provider and adds option contracts (OCC symbols).
 *
 * Option quotes are derived from the underlying: whenever an underlying ticks, every
 * demanded contract on it is re-priced (price, bid/ask, IV and Greeks) and emitted as a
 * normal quote. So options flow through the same QuoteHub as shares: the broker fills
 * option limit orders, the kill switch protects option positions, and the UI streams them.
 *
 * With a real options data feed, replace this with a provider that streams contracts directly.
 */
export class OptionsAwareProvider implements MarketDataProvider {
  readonly name: string;
  private byUnderlying = new Map<string, Map<string, OptionContract>>();
  private latest = new Map<string, Quote>();

  constructor(private base: MarketDataProvider, readonly model: SimulatedOptionModel) {
    this.name = base.name;
  }

  start(onQuotes: (quotes: Quote[]) => void): void {
    this.base.start((batch) => {
      const now = Date.now();
      const out = [...batch];
      for (const q of batch) {
        this.latest.set(q.symbol, q);
        const contracts = this.byUnderlying.get(q.symbol);
        if (!contracts) continue;
        this.model.nudge(q.symbol);
        for (const c of contracts.values()) out.push(this.model.quote(c, q, now));
      }
      onQuotes(out);
    });
  }

  stop(): void {
    this.base.stop();
  }

  setSymbols(symbols: string[]): void {
    const plain = new Set<string>();
    const next = new Map<string, Map<string, OptionContract>>();
    for (const s of symbols) {
      const c = parseOcc(s);
      if (!c) {
        plain.add(s);
        continue;
      }
      plain.add(c.underlying);
      let m = next.get(c.underlying);
      if (!m) next.set(c.underlying, (m = new Map()));
      m.set(s, c);
    }
    this.byUnderlying = next;
    this.base.setSymbols([...plain]);
  }

  async snapshot(symbols: string[]): Promise<Quote[]> {
    const contracts = new Map<string, OptionContract>();
    const plain = new Set<string>();
    for (const s of symbols) {
      const c = parseOcc(s);
      if (c) {
        contracts.set(s, c);
        plain.add(c.underlying);
      } else {
        plain.add(s);
      }
    }
    const base = await this.base.snapshot([...plain]);
    const bySym = new Map(base.map((q) => [q.symbol, q]));
    const now = Date.now();
    const out: Quote[] = [];
    for (const s of symbols) {
      const c = contracts.get(s);
      if (!c) {
        const q = bySym.get(s);
        if (q) out.push(q);
        continue;
      }
      const und = bySym.get(c.underlying) ?? this.latest.get(c.underlying);
      if (und) out.push(this.model.quote(c, und, now));
    }
    return out;
  }

  search(query: string): Promise<Instrument[]> {
    return this.base.search(query);
  }
}
