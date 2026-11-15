import type { Instrument, Quote } from "../types.js";
import type { MarketDataProvider } from "./provider.js";
import { search as catalogSearch } from "./catalog.js";
import { ALPACA_URLS } from "../brokers/alpaca.js";

interface Snapshot {
  latestTrade?: { p: number; t: string };
  latestQuote?: { bp: number; ap: number; t: string };
  dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string };
  prevDailyBar?: { c: number };
}

/**
 * Real stock/ETF prices from Alpaca's Market Data API (snapshots, polled).
 * The free plan uses the IEX feed: real trades and quotes from one exchange, so bid/ask can
 * be wider than the national best. Set feed "sip" if you pay for the full feed.
 * Option prices stay theoretical (Black-Scholes on the real underlying price).
 */
export class AlpacaDataProvider implements MarketDataProvider {
  readonly name = "alpaca";
  private symbols: string[] = [];
  private onQuotes: ((q: Quote[]) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = new Map<string, string>();
  private busy = false;
  private lastError = 0;
  private base: string;

  constructor(private keys: { keyId: string; secretKey: string }, private opts: { feed?: string; pollMs?: number; dataUrl?: string; fetch?: typeof fetch } = {}) {
    this.base = (opts.dataUrl ?? process.env.TD_ALPACA_DATA_URL ?? ALPACA_URLS.data).replace(/\/$/, "");
  }

  start(onQuotes: (quotes: Quote[]) => void): void {
    this.onQuotes = onQuotes;
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 1500);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onQuotes = null;
  }

  setSymbols(symbols: string[]): void {
    this.symbols = symbols.filter((s) => /^[A-Z][A-Z.]{0,9}$/.test(s));
    void this.poll();
  }

  async snapshot(symbols: string[]): Promise<Quote[]> {
    return this.fetchQuotes(symbols.filter((s) => /^[A-Z][A-Z.]{0,9}$/.test(s)));
  }

  async search(query: string): Promise<Instrument[]> {
    const hits = catalogSearch(query);
    // Any ticker-looking query is offered too, so you aren't limited to the built-in list.
    const q = query.trim().toUpperCase();
    if (/^[A-Z][A-Z.]{0,9}$/.test(q) && !hits.some((h) => h.symbol === q)) hits.unshift({ symbol: q, name: q, type: "stock" });
    return hits;
  }

  private async poll(): Promise<void> {
    if (this.busy || !this.onQuotes || !this.symbols.length) return;
    this.busy = true;
    try {
      const quotes = await this.fetchQuotes(this.symbols);
      const changed = quotes.filter((q) => {
        const key = `${q.last}|${q.bid}|${q.ask}|${q.volume}`;
        if (this.last.get(q.symbol) === key) return false;
        this.last.set(q.symbol, key);
        return true;
      });
      if (changed.length) this.onQuotes?.(changed);
    } catch (err) {
      if (Date.now() - this.lastError > 60_000) {
        this.lastError = Date.now();
        console.error(`Alpaca market data: ${(err as Error).message}`);
      }
    } finally {
      this.busy = false;
    }
  }

  private async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      const q = new URLSearchParams({ symbols: chunk.join(","), feed: this.opts.feed ?? "iex" });
      const res = await (this.opts.fetch ?? fetch)(`${this.base}/v2/stocks/snapshots?${q}`, {
        headers: { "APCA-API-KEY-ID": this.keys.keyId, "APCA-API-SECRET-KEY": this.keys.secretKey, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the API keys)" : ""}`);
      const data = (await res.json()) as Record<string, Snapshot | null>;
      for (const sym of chunk) {
        const s = data[sym];
        const quote = s ? toQuote(sym, s) : null;
        if (quote) out.push(quote);
      }
    }
    return out;
  }
}

export function toQuote(symbol: string, s: Snapshot): Quote | null {
  const last = s.latestTrade?.p ?? s.dailyBar?.c;
  if (!last) return null;
  const today = s.dailyBar && s.latestTrade && s.dailyBar.t.slice(0, 10) === s.latestTrade.t.slice(0, 10);
  const prevClose = (today ? s.prevDailyBar?.c : s.dailyBar?.c) ?? s.prevDailyBar?.c ?? last;
  const bid = s.latestQuote?.bp || last;
  const ask = s.latestQuote?.ap || last;
  return {
    symbol, last, bid: Math.min(bid, ask), ask: Math.max(bid, ask), prevClose,
    high: today ? s.dailyBar!.h : last, low: today ? s.dailyBar!.l : last, volume: today ? s.dailyBar!.v : 0,
    ts: Date.parse(s.latestTrade?.t ?? "") || Date.now(),
  };
}
