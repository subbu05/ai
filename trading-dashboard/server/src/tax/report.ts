import type { Fill, Quote } from "../types.js";
import type { Storage, JsonFile } from "../storage.js";
import { buildLots, daysBetween, type ClosedLot, type OpenLot, type Term } from "./lots.js";
import { estimateTax, DEFAULT_PROFILE, type TaxEstimate, type TaxProfile } from "./estimate.js";
import { FILING_STATUSES, type TaxRules } from "./rules.js";
import { HttpError, newId, normalizeSymbol, round2 } from "../util.js";
import { isOption, nyDate } from "../options/occ.js";

export interface Dividend {
  id: string;
  broker: string;
  symbol: string;
  date: string; // YYYY-MM-DD paid
  amount: number; // $ total
  qualified: boolean;
  note?: string;
}

export interface TermTotals { proceeds: number; cost: number; gains: number; losses: number; washDisallowed: number; net: number; count: number }
export interface OpenLotView extends OpenLot { mark: number | null; value: number | null; gain: number | null; term: Term; daysToLongTerm: number }
export interface SymbolTaxRow { symbol: string; shortTerm: number; longTerm: number; dividends: number; unrealized: number; total: number }

export interface TaxReport {
  year: number;
  years: number[];
  today: string;
  method: "FIFO";
  profile: TaxProfile;
  realized: { lots: ClosedLot[]; short: TermTotals; long: TermTotals };
  unrealized: { lots: OpenLotView[]; short: number; long: number; total: number; becomingLongTerm30d: number };
  dividends: { items: Dividend[]; qualified: number; ordinary: number; total: number };
  bySymbol: SymbolTaxRow[];
  estimate: TaxEstimate;
  ifSoldToday: TaxEstimate;
}

const totals = (lots: ClosedLot[]): TermTotals => {
  const t: TermTotals = { proceeds: 0, cost: 0, gains: 0, losses: 0, washDisallowed: 0, net: 0, count: lots.length };
  for (const l of lots) {
    t.proceeds += l.proceeds; t.cost += l.cost; t.washDisallowed += l.washDisallowed;
    if (l.gain >= 0) t.gains += l.gain; else t.losses += l.gain;
  }
  t.net = t.gains + t.losses + t.washDisallowed; // disallowed wash-sale losses aren't deductible this year
  for (const k of Object.keys(t) as (keyof TermTotals)[]) if (k !== "count") t[k] = round2(t[k]);
  return t;
};

export class TaxBook {
  private profileFile: JsonFile<TaxProfile>;
  private dividendsFile: JsonFile<Dividend[]>;

  constructor(storage: Storage, private rules: () => TaxRules) {
    this.profileFile = storage.json<TaxProfile>("tax-profile.json", { ...DEFAULT_PROFILE });
    this.dividendsFile = storage.json<Dividend[]>("dividends.json", []);
  }

  profile(): TaxProfile {
    return { ...DEFAULT_PROFILE, ...this.profileFile.get() };
  }

  setProfile(patch: Record<string, unknown>): TaxProfile {
    const p = this.profile();
    const money = (v: unknown, name: string, max = 1e9) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) throw new HttpError(400, `${name} must be a number between 0 and ${max}`);
      return round2(v);
    };
    if (patch.filingStatus !== undefined) {
      if (!FILING_STATUSES.includes(patch.filingStatus as TaxProfile["filingStatus"])) throw new HttpError(400, "Unknown filing status");
      p.filingStatus = patch.filingStatus as TaxProfile["filingStatus"];
    }
    if (patch.otherIncome !== undefined) p.otherIncome = money(patch.otherIncome, "Other income");
    if (patch.deduction !== undefined) p.deduction = patch.deduction === null ? null : money(patch.deduction, "Deduction");
    if (patch.stateRatePct !== undefined) p.stateRatePct = money(patch.stateRatePct, "State rate", 20);
    if (patch.lossCarryover !== undefined) p.lossCarryover = money(patch.lossCarryover, "Loss carryover");
    this.profileFile.set(p);
    return p;
  }

  dividends(broker: string): Dividend[] {
    return this.dividendsFile.get().filter((d) => d.broker === broker).sort((a, b) => b.date.localeCompare(a.date));
  }

  addDividend(broker: string, body: Record<string, unknown>): Dividend {
    const symbol = normalizeSymbol(body.symbol);
    if (!symbol || isOption(symbol)) throw new HttpError(400, "Enter a stock or ETF symbol");
    const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) && !Number.isNaN(Date.parse(body.date)) ? body.date : null;
    if (!date) throw new HttpError(400, "Date must be YYYY-MM-DD");
    const amount = body.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1e8) throw new HttpError(400, "Amount must be a positive number");
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 120) : undefined;
    const d: Dividend = { id: newId("div"), broker, symbol, date, amount: round2(amount), qualified: body.qualified !== false, ...(note ? { note } : {}) };
    this.dividendsFile.set([...this.dividendsFile.get(), d]);
    return d;
  }

  deleteDividend(id: string): boolean {
    const all = this.dividendsFile.get();
    const next = all.filter((d) => d.id !== id);
    if (next.length === all.length) return false;
    this.dividendsFile.set(next);
    return true;
  }

  report(opts: { year: number; broker: string; fills: Fill[]; quote: (s: string) => Quote | undefined; now?: number }): TaxReport {
    const rules = this.rules();
    const now = opts.now ?? Date.now();
    const today = nyDate(now);
    const profile = this.profile();
    const { closed, open } = buildLots(opts.fills, rules.washSaleDays);
    const allDivs = this.dividends(opts.broker);

    const years = new Set<number>([Number(today.slice(0, 4))]);
    for (const f of opts.fills) if (f.qty > 0 && f.symbol) years.add(Number(nyDate(f.ts).slice(0, 4)));
    for (const d of allDivs) years.add(Number(d.date.slice(0, 4)));

    const ys = String(opts.year);
    const lots = closed.filter((l) => l.sold.startsWith(ys)).sort((a, b) => b.soldTs - a.soldTs);
    const short = totals(lots.filter((l) => l.term === "short"));
    const long = totals(lots.filter((l) => l.term === "long"));

    const divs = allDivs.filter((d) => d.date.startsWith(ys));
    const qualified = round2(divs.filter((d) => d.qualified).reduce((s, d) => s + d.amount, 0));
    const ordinary = round2(divs.filter((d) => !d.qualified).reduce((s, d) => s + d.amount, 0));

    const openViews: OpenLotView[] = open.map((l) => {
      const q = opts.quote(l.symbol);
      // Options are valued at the mid (last trade can be stale); stocks at the last price.
      const mark = q ? (isOption(l.symbol) && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.last) : null;
      const value = mark === null ? null : round2(mark * l.qty * l.multiplier);
      const days = daysBetween(today, l.longTermOn);
      return { ...l, mark, value, gain: value === null ? null : round2(value - l.cost), term: days <= 0 ? "long" : "short", daysToLongTerm: Math.max(0, days) };
    });
    const uShort = round2(openViews.filter((l) => l.term === "short").reduce((s, l) => s + (l.gain ?? 0), 0));
    const uLong = round2(openViews.filter((l) => l.term === "long").reduce((s, l) => s + (l.gain ?? 0), 0));
    const soon = round2(openViews.filter((l) => l.term === "short" && l.daysToLongTerm <= 30 && (l.gain ?? 0) > 0).reduce((s, l) => s + (l.gain ?? 0), 0));

    const bySym = new Map<string, SymbolTaxRow>();
    const row = (s: string) => bySym.get(s) ?? bySym.set(s, { symbol: s, shortTerm: 0, longTerm: 0, dividends: 0, unrealized: 0, total: 0 }).get(s)!;
    for (const l of lots) { const r = row(l.symbol); const g = l.gain + l.washDisallowed; if (l.term === "short") r.shortTerm += g; else r.longTerm += g; }
    for (const d of divs) row(d.symbol).dividends += d.amount;
    for (const l of openViews) row(l.symbol).unrealized += l.gain ?? 0;
    const bySymbol = [...bySym.values()].map((r) => {
      const out = { ...r, shortTerm: round2(r.shortTerm), longTerm: round2(r.longTerm), dividends: round2(r.dividends), unrealized: round2(r.unrealized) };
      out.total = round2(out.shortTerm + out.longTerm + out.dividends + out.unrealized);
      return out;
    }).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

    const inv = { shortTerm: short.net, longTerm: long.net, qualifiedDividends: qualified, ordinaryDividends: ordinary };
    const isCurrentYear = opts.year === Number(today.slice(0, 4));
    const estimate = estimateTax(profile, inv, opts.year, rules);
    const ifSoldToday = isCurrentYear
      ? estimateTax(profile, { ...inv, shortTerm: inv.shortTerm + uShort, longTerm: inv.longTerm + uLong }, opts.year, rules)
      : estimate;

    return {
      year: opts.year, years: [...years].sort((a, b) => b - a), today, method: "FIFO", profile,
      realized: { lots, short, long },
      unrealized: { lots: openViews, short: uShort, long: uLong, total: round2(uShort + uLong), becomingLongTerm30d: soon },
      dividends: { items: divs, qualified, ordinary, total: round2(qualified + ordinary) },
      bySymbol, estimate, ifSoldToday,
    };
  }
}
