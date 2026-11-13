/**
 * Option contract symbols in OCC format without padding, e.g. AAPL261120C00230000:
 *   root (1-6 chars) + YYMMDD expiry + C/P + strike × 1000 (8 digits).
 * Option prices are per share; one contract = 100 shares.
 */
export const CONTRACT_MULTIPLIER = 100;

export type Right = "C" | "P";

export interface OptionContract {
  symbol: string;
  underlying: string;
  expiry: string; // YYYY-MM-DD
  right: Right;
  strike: number;
}

const OCC_RE = /^([A-Z][A-Z.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOcc(symbol: string): OptionContract | null {
  const m = OCC_RE.exec(symbol);
  if (!m) return null;
  const [, underlying, yy, mm, dd, right, k] = m;
  const month = Number(mm), day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { symbol, underlying, expiry: `20${yy}-${mm}-${dd}`, right: right as Right, strike: Number(k) / 1000 };
}

export const isOption = (symbol: string): boolean => parseOcc(symbol) !== null;

export function formatOcc(underlying: string, expiry: string, right: Right, strike: number): string {
  const [y, m, d] = expiry.split("-");
  return `${underlying}${y.slice(2)}${m}${d}${right}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/** Contract multiplier: 100 for options, 1 for shares. */
export const multiplier = (symbol: string): number => (isOption(symbol) ? CONTRACT_MULTIPLIER : 1);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "AAPL Nov 20 '26 $230 Call" */
export function describe(c: OptionContract): string {
  const [y, m, d] = c.expiry.split("-");
  return `${c.underlying} ${MONTHS[Number(m) - 1]} ${Number(d)} '${y.slice(2)} $${c.strike} ${c.right === "C" ? "Call" : "Put"}`;
}

const nyHourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
const nyDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const expiryCache = new Map<string, number>();

/**
 * Expiration moment: 4:00 pm New York time on the expiry date, as epoch ms
 * (handles daylight saving: 20:00 UTC in summer, 21:00 UTC in winter).
 */
export function expiryTime(expiry: string): number {
  const hit = expiryCache.get(expiry);
  if (hit !== undefined) return hit;
  const [y, m, d] = expiry.split("-").map(Number);
  let out = Date.UTC(y, m - 1, d, 21);
  const summer = Date.UTC(y, m - 1, d, 20);
  if (Number(nyHourFmt.format(summer)) === 16) out = summer;
  expiryCache.set(expiry, out);
  return out;
}

/** A date in New York as YYYY-MM-DD. */
export const nyDate = (ts: number): string => nyDateFmt.format(ts);
