import type { Quote } from "../types.js";
import { lookup } from "../market/catalog.js";
import { blackScholes } from "./bs.js";
import { expiryTime, nyDate, type OptionContract } from "./occ.js";
import { round2 } from "../util.js";

const YEAR_MS = 365 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export interface Expiration {
  date: string; // YYYY-MM-DD
  dte: number; // calendar days to expiry
  kind: "weekly" | "monthly";
}

const isThirdFriday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).getUTCDay() === 5 && d >= 15 && d <= 21;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Listed expirations: the next `weeks` Fridays (weeklies) plus the monthly (third-Friday)
 * expirations for the next `months` months. Expired dates (after 4 pm New York) are skipped.
 * Exchange holidays are ignored in the simulation.
 */
export function listExpirations(now = Date.now(), weeks = 8, months = 6): Expiration[] {
  const today = nyDate(now);
  const [ty, tm, td] = today.split("-").map(Number);
  const base = Date.UTC(ty, tm - 1, td);
  const dates = new Set<string>();
  for (let i = 0, found = 0; found < weeks && i < 400; i++) {
    const t = base + i * DAY_MS;
    if (new Date(t).getUTCDay() !== 5) continue;
    const date = ymd(t);
    if (expiryTime(date) <= now) continue;
    dates.add(date);
    found++;
  }
  for (let k = 0; k <= months; k++) {
    const first = new Date(Date.UTC(ty, tm - 1 + k, 1));
    const shift = (5 - first.getUTCDay() + 7) % 7;
    const date = ymd(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 + shift + 14));
    if (expiryTime(date) > now) dates.add(date);
  }
  return [...dates].sort().map((date) => {
    const [y, m, d] = date.split("-").map(Number);
    return { date, dte: Math.round((Date.UTC(y, m - 1, d) - base) / DAY_MS), kind: isThirdFriday(y, m - 1, d) ? "monthly" : "weekly" };
  });
}

/** Strike spacing used by most listed equity options at this price level. */
export function strikeStep(price: number): number {
  if (price < 25) return 0.5;
  if (price < 100) return 1;
  if (price < 250) return 2.5;
  if (price < 1000) return 5;
  return 10;
}

/** `each` strikes below and above the at-the-money strike. */
export function strikesAround(price: number, each: number): number[] {
  const step = strikeStep(price);
  const atm = Math.round(price / step) * step;
  const out: number[] = [];
  for (let i = -each; i <= each; i++) {
    const k = Math.round((atm + i * step) * 1000) / 1000;
    if (k > 0) out.push(k);
  }
  return out;
}

/** Deterministic pseudo-random number in [0, 1) from a string. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

interface ContractState {
  prevClose: number;
  last: number;
  high: number;
  low: number;
  volume: number;
  oi: number;
  dailyVol: number;
}

/**
 * Simulated option market for the offline demo: prices come from Black-Scholes on the live
 * (simulated) underlying, with a per-symbol volatility level, an equity-style skew/smile
 * and a gently wandering IV. Volume and open interest are synthetic but deterministic,
 * and highest near the money, like real chains.
 */
export class SimulatedOptionModel {
  private state = new Map<string, ContractState>();
  private ivShift = new Map<string, number>();

  constructor(private rate: number) {}

  get riskFreeRate(): number {
    return this.rate;
  }

  baseIv(underlying: string): number {
    const h = hash01(`iv:${underlying}`);
    return lookup(underlying).type === "etf" ? 0.13 + h * 0.12 : 0.22 + h * 0.33;
  }

  /** Called once per underlying tick: IV wanders a little, mean-reverting to its base. */
  nudge(underlying: string): void {
    const s = this.ivShift.get(underlying) ?? 0;
    this.ivShift.set(underlying, s * 0.995 + (Math.random() - 0.5) * 0.004);
  }

  iv(c: OptionContract, S: number, T: number): number {
    const m = Math.log(c.strike / S) / Math.sqrt(Math.max(T, 7 / 365));
    const smile = 1 - 0.22 * m + 0.3 * m * m; // downside strikes richer (equity skew)
    const term = 1 + 0.1 * Math.exp(-T * 8); // front expiries a bit richer
    const v = this.baseIv(c.underlying) * (1 + (this.ivShift.get(c.underlying) ?? 0)) * smile * term;
    return Math.min(2.5, Math.max(0.05, v));
  }

  quote(c: OptionContract, und: Quote, now = Date.now()): Quote {
    const T = Math.max(0, expiryTime(c.expiry) - now) / YEAR_MS;
    const sigma = this.iv(c, und.last, T);
    const g = blackScholes(c.right, und.last, c.strike, T, this.rate, 0, sigma);
    const theo = g.price;
    let bid: number, ask: number;
    if (T <= 0) {
      bid = ask = round2(theo);
    } else {
      const half = Math.max(0.01, Math.min(0.5, round2(theo * 0.012)));
      bid = Math.max(0, round2(theo - half));
      ask = Math.max(0.01, round2(theo + half));
    }

    let st = this.state.get(c.symbol);
    if (!st) {
      const m = Math.log(c.strike / und.last);
      const liquidity = lookup(c.underlying).type === "etf" ? 40_000 : 12_000;
      const dailyVol = Math.max(5, liquidity * Math.exp(-m * m * 60) * (0.4 + hash01(`v:${c.symbol}`)));
      const prev = blackScholes(c.right, und.prevClose, c.strike, T + 1 / 365, this.rate, 0, this.iv(c, und.prevClose, T + 1 / 365)).price;
      const last = round2(theo);
      st = {
        prevClose: Math.max(0.01, round2(prev)),
        last, high: last, low: last,
        volume: Math.floor(dailyVol * (0.15 + 0.6 * hash01(`d:${c.symbol}`))),
        oi: Math.floor(dailyVol * (1.5 + 7 * hash01(`oi:${c.symbol}`))),
        dailyVol,
      };
      this.state.set(c.symbol, st);
    } else if (Math.random() < 0.3 && ask > 0) {
      // A trade prints somewhere inside the spread.
      st.last = round2(bid + Math.random() * (ask - bid));
      st.volume += 1 + Math.floor(Math.random() * Math.max(1, st.dailyVol / 3000));
      if (st.last > st.high) st.high = st.last;
      if (st.last < st.low) st.low = st.last;
    }

    return {
      symbol: c.symbol,
      last: st.last, bid, ask,
      prevClose: st.prevClose, high: st.high, low: st.low, volume: st.volume,
      ts: Math.max(und.ts, now),
      greeks: { iv: sigma, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: g.rho },
      oi: st.oi,
      underlyingPrice: und.last,
    };
  }
}
