import { brackets, rulesFor, type Bracket, type FilingStatus, type TaxRules } from "./rules.js";
import { round2 } from "../util.js";

export interface TaxProfile {
  filingStatus: FilingStatus;
  /** Wages and other ordinary income for the year, before deductions. */
  otherIncome: number;
  /** null = use the standard deduction. */
  deduction: number | null;
  /** Flat state income tax rate on investment income, in percent. */
  stateRatePct: number;
  /** Capital loss carried over from earlier years (positive number). */
  lossCarryover: number;
}

export const DEFAULT_PROFILE: TaxProfile = { filingStatus: "single", otherIncome: 0, deduction: null, stateRatePct: 0, lossCarryover: 0 };

export interface InvestmentIncome {
  shortTerm: number; // net short-term gain (+) or loss (-)
  longTerm: number;
  qualifiedDividends: number;
  ordinaryDividends: number; // non-qualified
}

export interface TaxEstimate {
  rulesYear: number;
  rulesExact: boolean;
  deduction: number;
  /** After netting short against long: what's taxed at ordinary vs long-term rates. */
  netShortTerm: number;
  netLongTerm: number;
  netCapital: number;
  lossDeducted: number; // capital loss used against other income this year (<= limit), positive
  lossCarryforward: number; // left to carry into next year, positive
  taxableIncome: number;
  federalTax: number;
  niit: number;
  stateTax: number;
  /** Total tax with vs without the investment income: what your trading costs (or saves) you. */
  taxOnInvestments: number;
  shortTermTax: number; // share of taxOnInvestments from short-term gains + ordinary dividends
  longTermTax: number; // share from long-term gains + qualified dividends
  investmentIncome: number;
  effectiveRatePct: number | null;
  marginalOrdinaryPct: number;
  marginalLongTermPct: number;
  ordinaryBrackets: Bracket[];
  longTermBrackets: Bracket[];
  /** Taxable income taxed at ordinary rates / at preferential rates (where you sit on each table). */
  ordinaryTaxable: number;
  preferentialTaxable: number;
}

function bracketTax(income: number, table: Bracket[]): number {
  let tax = 0;
  for (const b of table) {
    if (income <= b.from) break;
    tax += (Math.min(income, b.to ?? Infinity) - b.from) * b.rate;
  }
  return tax;
}

/** Long-term gains and qualified dividends are stacked on top of ordinary income. */
function preferentialTax(ordinaryTaxable: number, pref: number, table: Bracket[]): number {
  let tax = 0;
  const lo = ordinaryTaxable, hi = ordinaryTaxable + pref;
  for (const b of table) {
    const top = b.to ?? Infinity;
    const part = Math.max(0, Math.min(hi, top) - Math.max(lo, b.from));
    tax += part * b.rate;
  }
  return tax;
}

const rateAt = (income: number, table: Bracket[]) => (table.find((b) => income < (b.to ?? Infinity)) ?? table[table.length - 1]).rate;

interface Scenario { federal: number; niit: number; state: number; taxable: number; ordTaxable: number; pref: number;
  netST: number; netLT: number; net: number; lossDeducted: number; carry: number; }

function scenario(p: TaxProfile, inv: InvestmentIncome, year: number, rules: TaxRules, ordinary: Bracket[], lt: Bracket[], deduction: number): Scenario {
  const status = p.filingStatus;
  // Netting: carryover is applied against short-term first (simplification), then short vs long.
  let st = inv.shortTerm - Math.max(0, p.lossCarryover);
  let ltg = inv.longTerm;
  if (st < 0 && ltg > 0) { const used = Math.min(-st, ltg); ltg -= used; st += used; }
  else if (ltg < 0 && st > 0) { const used = Math.min(-ltg, st); st -= used; ltg += used; }
  const net = st + ltg;
  const limit = rules.capitalLossLimit[status];
  const lossDeducted = net < 0 ? Math.min(-net, limit) : 0;
  const carry = net < 0 ? -net - lossDeducted : 0;
  const ordGain = net > 0 ? Math.max(0, st) : 0;
  const prefGain = net > 0 ? Math.max(0, ltg) : 0;

  const agi = Math.max(0, p.otherIncome) + inv.ordinaryDividends + inv.qualifiedDividends + ordGain + prefGain - lossDeducted;
  const taxable = Math.max(0, agi - deduction);
  const pref = Math.min(taxable, inv.qualifiedDividends + prefGain);
  const ordTaxable = taxable - pref;
  const federal = bracketTax(ordTaxable, ordinary) + preferentialTax(ordTaxable, pref, lt);

  const nii = Math.max(0, inv.ordinaryDividends + inv.qualifiedDividends + ordGain + prefGain - lossDeducted);
  const niit = rules.niit.rate * Math.min(nii, Math.max(0, agi - rules.niit.threshold[status]));
  const state = (Math.max(0, p.stateRatePct) / 100) * nii;
  void year;
  return { federal, niit, state, taxable, ordTaxable, pref, netST: st, netLT: ltg, net, lossDeducted, carry };
}

/**
 * Estimated US federal (+ NIIT + flat state) tax for one year. Compares the year with and
 * without your investment income, so the "tax on investments" figure is the extra tax
 * (or savings, if negative) caused by trading and dividends.
 */
export function estimateTax(profile: TaxProfile, inv: InvestmentIncome, year: number, rules: TaxRules): TaxEstimate {
  const { year: rulesYear, exact, r } = rulesFor(rules, year);
  const status = profile.filingStatus;
  const ordinary = brackets(r.ordinary, status);
  const lt = brackets(r.longTerm, status);
  const deduction = profile.deduction ?? r.standardDeduction[status];

  const zero: InvestmentIncome = { shortTerm: 0, longTerm: 0, qualifiedDividends: 0, ordinaryDividends: 0 };
  const noCarry = { ...profile, lossCarryover: 0 };
  const base = scenario(noCarry, zero, year, rules, ordinary, lt, deduction);
  const full = scenario(profile, inv, year, rules, ordinary, lt, deduction);
  const total = (s: Scenario) => s.federal + s.niit + s.state;
  const taxOnInvestments = total(full) - total(base);

  // Split the extra tax into the short-term (ordinary-rate) and long-term (preferential) parts.
  const ltOnly = scenario(profile, { ...inv, shortTerm: 0, ordinaryDividends: 0 }, year, rules, ordinary, lt, deduction);
  const longTermTax = total(ltOnly) - total(base);
  const investmentIncome = inv.shortTerm + inv.longTerm + inv.qualifiedDividends + inv.ordinaryDividends;

  return {
    rulesYear, rulesExact: exact, deduction: round2(deduction),
    netShortTerm: round2(full.netST), netLongTerm: round2(full.netLT), netCapital: round2(full.net),
    lossDeducted: round2(full.lossDeducted), lossCarryforward: round2(full.carry),
    taxableIncome: round2(full.taxable), federalTax: round2(full.federal), niit: round2(full.niit), stateTax: round2(full.state),
    taxOnInvestments: round2(taxOnInvestments),
    longTermTax: round2(longTermTax), shortTermTax: round2(taxOnInvestments - longTermTax),
    investmentIncome: round2(investmentIncome),
    effectiveRatePct: investmentIncome > 0 ? round2((taxOnInvestments / investmentIncome) * 100) : null,
    marginalOrdinaryPct: round2(rateAt(full.ordTaxable, ordinary) * 100),
    marginalLongTermPct: round2(rateAt(full.ordTaxable + full.pref, lt) * 100),
    ordinaryBrackets: ordinary, longTermBrackets: lt,
    ordinaryTaxable: round2(full.ordTaxable), preferentialTaxable: round2(full.pref),
  };
}
