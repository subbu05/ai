import { useCallback, useSyncExternalStore } from "react";
import type { Quote } from "./types";

/**
 * Live quote store, optimized for many rows updating many times a second:
 *  - Per-symbol listeners: a tick for AAPL re-renders only components showing AAPL.
 *  - Frame batching: updates that arrive between frames are applied together on the next
 *    requestAnimationFrame, so React does at most one render pass per frame.
 *  - Quotes are immutable objects, so useSyncExternalStore snapshots compare by reference.
 */
/** [symbol, last, bid, ask, prevClose, high, low, volume, ts, ...options: iv, delta, gamma, theta, vega, rho, oi, underlyingPrice] */
type Row = [string, number, number, number, number, number, number, number, number, ...number[]];

const quotes = new Map<string, Quote>();
const symbolListeners = new Map<string, Set<() => void>>();
const anyListeners = new Set<() => void>();
let pending: Row[] = [];
let frame = 0;
let version = 0;

export function ingestRows(rows: Row[]): void {
  for (const r of rows) pending.push(r);
  if (!frame) frame = requestAnimationFrame(apply);
}

export function ingestQuotes(list: Omit<Quote, "dir">[]): void {
  ingestRows(list.map((q): Row => {
    const base: Row = [q.symbol, q.last, q.bid, q.ask, q.prevClose, q.high, q.low, q.volume, q.ts];
    const g = q.greeks;
    return g ? [...base, g.iv, g.delta, g.gamma, g.theta, g.vega, g.rho, q.oi ?? 0, q.underlyingPrice ?? 0] as Row : base;
  }));
}

function apply(): void {
  frame = 0;
  const batch = pending;
  pending = [];
  const touched = new Set<string>();
  for (const r of batch) {
    const [symbol, last, bid, ask, prevClose, high, low, volume, ts] = r;
    const prev = quotes.get(symbol);
    if (prev && prev.ts > ts) continue;
    const dir = prev ? Math.sign(last - prev.last) : 0;
    const q: Quote = { symbol, last, bid, ask, prevClose, high, low, volume, ts, dir };
    if (r.length > 9) {
      q.greeks = { iv: r[9], delta: r[10], gamma: r[11], theta: r[12], vega: r[13], rho: r[14] };
      q.oi = r[15];
      q.underlyingPrice = r[16];
    }
    quotes.set(symbol, q);
    touched.add(symbol);
  }
  if (!touched.size) return;
  version++;
  for (const s of touched) {
    const set = symbolListeners.get(s);
    if (set) for (const l of set) l();
  }
  for (const l of anyListeners) l();
}

export const getQuote = (symbol: string): Quote | undefined => quotes.get(symbol);

function subscribeSymbol(symbol: string, l: () => void): () => void {
  let set = symbolListeners.get(symbol);
  if (!set) symbolListeners.set(symbol, (set = new Set()));
  set.add(l);
  return () => {
    set!.delete(l);
    if (!set!.size) symbolListeners.delete(symbol);
  };
}

const subscribeAny = (l: () => void) => {
  anyListeners.add(l);
  return () => anyListeners.delete(l);
};

/** Re-renders only when this symbol's quote changes. */
export function useQuote(symbol: string): Quote | undefined {
  const subscribe = useCallback((l: () => void) => subscribeSymbol(symbol, l), [symbol]);
  return useSyncExternalStore(subscribe, () => quotes.get(symbol));
}

/** Re-renders on any quote change (at most once per frame). Use for aggregates. */
export function useQuotesVersion(): number {
  return useSyncExternalStore(subscribeAny, () => version);
}
