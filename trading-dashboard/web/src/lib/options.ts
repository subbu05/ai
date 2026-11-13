import type { Quote } from "./types";

/** Option contract symbols (OCC, unpadded), e.g. AAPL261120C00230000. Mirrors server/src/options/occ.ts. */
export interface OptionContract {
  symbol: string;
  underlying: string;
  expiry: string; // YYYY-MM-DD
  right: "C" | "P";
  strike: number;
}

export const CONTRACT_MULTIPLIER = 100;
const OCC_RE = /^([A-Z][A-Z.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const cache = new Map<string, OptionContract | null>();

export function parseOcc(symbol: string): OptionContract | null {
  let hit = cache.get(symbol);
  if (hit !== undefined) return hit;
  const m = OCC_RE.exec(symbol);
  hit = m ? { symbol, underlying: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, right: m[5] as "C" | "P", strike: Number(m[6]) / 1000 } : null;
  cache.set(symbol, hit);
  return hit;
}

export const isOption = (symbol: string) => parseOcc(symbol) !== null;

/** Contract multiplier: 100 for options, 1 for shares. */
export const mult = (symbol: string) => (isOption(symbol) ? CONTRACT_MULTIPLIER : 1);

/**
 * Price used to value a position: mid for options (their last trade can be stale), last for shares.
 */
export function markPrice(q: Quote | undefined, symbol: string): number | undefined {
  if (!q) return undefined;
  if (isOption(symbol) && q.ask > 0) return Math.round(((q.bid + q.ask) / 2) * 100) / 100;
  return q.last;
}

/** Same as markPrice, for the previous close (day P&L). */
export const prevMark = (q: Quote | undefined) => q?.prevClose;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtExpiry(expiry: string, withYear = true): string {
  const [y, m, d] = expiry.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}${withYear ? ` '${y.slice(2)}` : ""}`;
}

/** "$230 Call · Nov 20 '26" */
export function contractLabel(c: OptionContract): string {
  return `$${c.strike} ${c.right === "C" ? "Call" : "Put"} · ${fmtExpiry(c.expiry)}`;
}

/** "AAPL $230C Nov 20" (compact, for tables) */
export function contractShort(c: OptionContract): string {
  return `${c.underlying} $${c.strike}${c.right} ${fmtExpiry(c.expiry, false)}`;
}

/** Calendar days to expiry (0 on expiration day), in New York time. */
export function daysToExpiry(expiry: string, now = Date.now()): number {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const [ty, tm, td] = today.split("-").map(Number);
  const [y, m, d] = expiry.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 864e5);
}

/** Decision helpers for one contract at its current quote (per share unless noted). */
export function analyze(c: OptionContract, q: Quote | undefined, S: number | undefined) {
  if (!q || S === undefined) return null;
  const mid = q.ask > 0 ? (q.bid + q.ask) / 2 : q.last;
  const intrinsic = Math.max(0, c.right === "C" ? S - c.strike : c.strike - S);
  const timeValue = Math.max(0, mid - intrinsic);
  const breakeven = c.right === "C" ? c.strike + q.ask : c.strike - q.ask;
  const moveToBreakeven = ((breakeven - S) / S) * 100;
  const spreadPct = mid > 0 ? ((q.ask - q.bid) / mid) * 100 : undefined;
  const g = q.greeks;
  return {
    mid, intrinsic, timeValue, breakeven, moveToBreakeven, spreadPct,
    costPerContract: q.ask * CONTRACT_MULTIPLIER,
    /** |delta| is a common rough estimate of the chance of finishing in the money. */
    probItm: g ? Math.abs(g.delta) * 100 : undefined,
    thetaPerContract: g ? g.theta * CONTRACT_MULTIPLIER : undefined,
    deltaDollars: g ? g.delta * CONTRACT_MULTIPLIER : undefined,
    maxLoss: q.ask * CONTRACT_MULTIPLIER,
    maxProfit: c.right === "C" ? Infinity : (c.strike - q.ask) * CONTRACT_MULTIPLIER,
    itm: intrinsic > 0,
  };
}
