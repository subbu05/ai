import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";

export type FilingStatus = "single" | "mfj" | "mfs" | "hoh";
export const FILING_STATUSES: FilingStatus[] = ["single", "mfj", "mfs", "hoh"];

export interface YearRules {
  standardDeduction: Record<FilingStatus, number>;
  /** `rates` has one more entry than each threshold list: the last rate applies above the last threshold. */
  ordinary: { rates: number[] } & Record<FilingStatus, number[]>;
  longTerm: { rates: number[] } & Record<FilingStatus, number[]>;
}

export interface TaxRules {
  years: Record<string, YearRules>;
  niit: { rate: number; threshold: Record<FilingStatus, number> };
  capitalLossLimit: Record<FilingStatus, number>;
  washSaleDays: number;
}

export interface Bracket { rate: number; from: number; to: number | null }

let cached: TaxRules | null = null;

/** Loads config/tax-rules.json (editable by the user). */
export function loadTaxRules(file = join(ROOT, "config", "tax-rules.json")): TaxRules {
  if (cached) return cached;
  if (!existsSync(file)) throw new Error(`Missing tax rules file: ${file}`);
  const r = JSON.parse(readFileSync(file, "utf8")) as TaxRules;
  if (!r.years || !Object.keys(r.years).length) throw new Error("tax-rules.json has no years");
  cached = r;
  return r;
}

/** Rules for `year`, or the closest year available (and which year was used). */
export function rulesFor(rules: TaxRules, year: number): { year: number; exact: boolean; r: YearRules } {
  const years = Object.keys(rules.years).map(Number).sort((a, b) => a - b);
  const pick = years.includes(year) ? year : years.reduce((best, y) => (Math.abs(y - year) < Math.abs(best - year) ? y : best), years[0]);
  return { year: pick, exact: pick === year, r: rules.years[String(pick)] };
}

export function brackets(table: { rates: number[] } & Record<FilingStatus, number[]>, status: FilingStatus): Bracket[] {
  const tops = table[status];
  return table.rates.map((rate, i) => ({ rate, from: i === 0 ? 0 : tops[i - 1], to: i < tops.length ? tops[i] : null }));
}
