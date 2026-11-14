import type { Fill } from "../types.js";
import { multiplier, nyDate } from "../options/occ.js";
import { round2, round6 } from "../util.js";

export type Term = "short" | "long";

/** A sold (closed) tax lot: one purchase matched to one sale, FIFO. */
export interface ClosedLot {
  symbol: string;
  qty: number;
  acquired: string; // YYYY-MM-DD (New York date)
  sold: string;
  acquiredTs: number;
  soldTs: number;
  proceeds: number; // $ (contract multiplier applied)
  cost: number;
  gain: number; // proceeds - cost
  term: Term;
  daysHeld: number;
  /** Loss not deductible now because the same security was bought within 30 days of this sale. */
  washDisallowed: number;
  buyFillId: string;
  sellFillId: string;
}

/** A lot still held. */
export interface OpenLot {
  symbol: string;
  qty: number;
  acquired: string;
  acquiredTs: number;
  price: number; // per share / per contract premium
  cost: number; // $ total
  multiplier: number;
  /** First date a sale counts as long-term (the day after the 1-year anniversary). */
  longTermOn: string;
  buyFillId: string;
}

const DAY = 86_400_000;

/** Long-term = held more than one year: sold on or after the day after the anniversary. */
export function longTermDate(acquired: string): string {
  const [y, m, d] = acquired.split("-").map(Number);
  const anniv = new Date(Date.UTC(y + 1, m - 1, d));
  if (anniv.getUTCMonth() !== m - 1) anniv.setUTCDate(0); // Feb 29 -> Feb 28
  return new Date(anniv.getTime() + DAY).toISOString().slice(0, 10);
}

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * Matches sells to buys first-in-first-out (the IRS default when you don't pick lots),
 * splits gains into short/long term, and flags wash sales.
 */
export function buildLots(fillsIn: Fill[], washDays = 30): { closed: ClosedLot[]; open: OpenLot[] } {
  const fills = [...fillsIn].filter((f) => f.qty > 0 && f.symbol).sort((a, b) => a.ts - b.ts);
  const queues = new Map<string, { fill: Fill; left: number }[]>();
  const closed: ClosedLot[] = [];

  for (const f of fills) {
    const q = queues.get(f.symbol) ?? [];
    queues.set(f.symbol, q);
    if (f.side === "buy") {
      q.push({ fill: f, left: f.qty });
      continue;
    }
    let toSell = f.qty;
    const m = multiplier(f.symbol);
    while (toSell > 1e-9 && q.length) {
      const lot = q[0];
      const qty = Math.min(lot.left, toSell);
      const acquired = nyDate(lot.fill.ts);
      const sold = nyDate(f.ts);
      const proceeds = qty * f.price * m;
      const cost = qty * lot.fill.price * m;
      closed.push({
        symbol: f.symbol, qty: round6(qty), acquired, sold, acquiredTs: lot.fill.ts, soldTs: f.ts,
        proceeds: round2(proceeds), cost: round2(cost), gain: round2(proceeds - cost),
        term: sold >= longTermDate(acquired) ? "long" : "short",
        daysHeld: daysBetween(acquired, sold), washDisallowed: 0,
        buyFillId: lot.fill.id, sellFillId: f.id,
      });
      lot.left -= qty;
      toSell -= qty;
      if (lot.left <= 1e-9) q.shift();
    }
    // A sell beyond what we know was bought (history before this app) has no basis to match; skip it.
  }

  // Wash sales: a loss is disallowed (for now) if the same security was bought within
  // `washDays` days before or after the sale, other than the lot being sold.
  const buysBySymbol = new Map<string, Fill[]>();
  for (const f of fills) if (f.side === "buy") (buysBySymbol.get(f.symbol) ?? buysBySymbol.set(f.symbol, []).get(f.symbol)!).push(f);
  for (const lot of closed) {
    if (lot.gain >= 0) continue;
    const win = washDays * DAY;
    let replacement = 0;
    for (const b of buysBySymbol.get(lot.symbol) ?? []) {
      if (b.id === lot.buyFillId) continue;
      if (Math.abs(b.ts - lot.soldTs) <= win) replacement += b.qty;
    }
    if (replacement > 0) lot.washDisallowed = round2(-lot.gain * Math.min(1, replacement / lot.qty));
  }

  const open: OpenLot[] = [];
  for (const [symbol, q] of queues) {
    for (const { fill, left } of q) {
      if (left <= 1e-9) continue;
      const acquired = nyDate(fill.ts);
      const m = multiplier(symbol);
      open.push({
        symbol, qty: round6(left), acquired, acquiredTs: fill.ts, price: fill.price,
        cost: round2(left * fill.price * m), multiplier: m, longTermOn: longTermDate(acquired), buyFillId: fill.id,
      });
    }
  }
  open.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.acquiredTs - b.acquiredTs);
  return { closed, open };
}
