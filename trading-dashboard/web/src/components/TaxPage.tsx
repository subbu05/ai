import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { displayName, toast } from "../lib/store";
import { fmtPct, fmtSignedUsd, fmtUsd, fmtQty, tone } from "../lib/format";
import type { Bracket, ClosedLot, FilingStatus, TaxProfile, TaxReport, Term } from "../lib/types";

const STATUS_LABEL: Record<FilingStatus, string> = {
  single: "Single", mfj: "Married filing jointly", mfs: "Married filing separately", hoh: "Head of household",
};
const lotsText = (n: number) => `${n} lot${n === 1 ? "" : "s"}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * P&L & Taxes page: realized gains split short-term / long-term (FIFO lots), unrealized gains,
 * dividends, and an estimate of the US federal (+ NIIT + state) tax they cause.
 */
export function TaxPage() {
  const [year, setYear] = useState<number | undefined>(undefined);
  const [report, setReport] = useState<TaxReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.taxReport(year));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [year]);

  // Unrealized gains move with prices: refresh every 5 s while the page is visible.
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(id);
  }, [load]);

  if (!report) return <div className="tax-page"><p className="muted pad">{error ?? "Loading…"}</p></div>;
  const r = report;
  const e = r.estimate;
  const isCurrent = r.year === Number(r.today.slice(0, 4));
  const realizedNet = r.realized.short.net + r.realized.long.net;
  const afterTax = realizedNet + r.dividends.total - e.taxOnInvestments;

  return (
    <div className="tax-page">
      <div className="tax-toolbar">
        <h1>P&L &amp; Taxes</h1>
        <label className="field-inline">Tax year
          <select value={r.year} onChange={(ev) => setYear(Number(ev.target.value))}>
            {r.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <span className="muted small">Lots matched first-in-first-out (FIFO) · prices refresh every 5 s</span>
        <span className="spacer" />
        <button className="btn" onClick={() => exportCsv(r)} disabled={!r.realized.lots.length}
          title="Download realized lots in Form 8949 layout">⬇ Export CSV (Form 8949)</button>
      </div>
      {error && <p className="tax-error">Couldn't refresh: {error}</p>}

      <section className="tax-cards">
        <Card title="Short-term realized" hint="Held 1 year or less. Taxed as ordinary income at your bracket rate."
          value={fmtSignedUsd(r.realized.short.net)} t={tone(r.realized.short.net)}
          lines={[`${lotsText(r.realized.short.count)} · gains ${fmtUsd(r.realized.short.gains)} · losses ${fmtSignedUsd(r.realized.short.losses)}`,
            r.realized.short.washDisallowed ? `Wash-sale loss not deductible: ${fmtUsd(r.realized.short.washDisallowed)}` : ""]} />
        <Card title="Long-term realized" hint="Held more than 1 year. Taxed at 0%, 15% or 20%."
          value={fmtSignedUsd(r.realized.long.net)} t={tone(r.realized.long.net)}
          lines={[`${lotsText(r.realized.long.count)} · gains ${fmtUsd(r.realized.long.gains)} · losses ${fmtSignedUsd(r.realized.long.losses)}`,
            r.realized.long.washDisallowed ? `Wash-sale loss not deductible: ${fmtUsd(r.realized.long.washDisallowed)}` : ""]} />
        <Card title="Dividends" hint="Qualified dividends are taxed like long-term gains; ordinary (non-qualified) like short-term."
          value={fmtUsd(r.dividends.total)} t={r.dividends.total ? "up" : "flat"}
          lines={[`Qualified ${fmtUsd(r.dividends.qualified)} · ordinary ${fmtUsd(r.dividends.ordinary)}`]} />
        <Card title="Unrealized (not sold)" hint="Paper gains on what you still hold. Not taxed until you sell."
          value={fmtSignedUsd(r.unrealized.total)} t={tone(r.unrealized.total)}
          lines={[`Short-term ${fmtSignedUsd(r.unrealized.short)} · long-term ${fmtSignedUsd(r.unrealized.long)}`]} />
        <Card title={`Estimated tax on trading, ${r.year}`} accent
          hint="Extra federal + NIIT + state tax caused by your realized gains and dividends, compared with the same year without them. Negative = your losses save tax."
          value={fmtSignedUsd(e.taxOnInvestments)} t={e.taxOnInvestments > 0 ? "down" : e.taxOnInvestments < 0 ? "up" : "flat"}
          lines={[`Short-term ${fmtUsd(e.shortTermTax)} · long-term ${fmtUsd(e.longTermTax)}`,
            `${e.niit ? `NIIT ${fmtUsd(e.niit)} · ` : ""}${e.stateTax ? `state ${fmtUsd(e.stateTax)} · ` : ""}effective ${e.effectiveRatePct === null ? "—" : `${e.effectiveRatePct}%`}`]} />
        <Card title="Realized P&L after tax" hint="Realized gains + dividends − estimated tax."
          value={fmtSignedUsd(afterTax)} t={tone(afterTax)}
          lines={[`Before tax ${fmtSignedUsd(realizedNet + r.dividends.total)}`]} />
      </section>

      <div className="tax-grid">
        <Panel title="Your tax situation" sub="Used only for the estimates on this page. Stored on this computer.">
          <ProfileForm profile={r.profile} standard={e.deduction} onSaved={load} />
        </Panel>
        <Panel title="Where you sit in the brackets"
          sub={`US federal ${e.rulesYear}${e.rulesExact ? "" : ` (no ${r.year} table, using ${e.rulesYear})`} · ${STATUS_LABEL[r.profile.filingStatus]}`}>
          <BracketBar label="Ordinary income & short-term gains" brackets={e.ordinaryBrackets} from={0} to={e.ordinaryTaxable}
            marginal={e.marginalOrdinaryPct} />
          <BracketBar label="Long-term gains & qualified dividends" brackets={e.longTermBrackets} from={e.ordinaryTaxable}
            to={e.ordinaryTaxable + e.preferentialTaxable} marginal={e.marginalLongTermPct} stacked />
          <dl className="tax-facts">
            <dt>Taxable income</dt><dd>{fmtUsd(e.taxableIncome)}</dd>
            <dt>Deduction</dt><dd>{fmtUsd(e.deduction)}{r.profile.deduction === null ? " (standard)" : ""}</dd>
            <dt>Next $1 short-term</dt><dd>{e.marginalOrdinaryPct}% federal</dd>
            <dt>Next $1 long-term</dt><dd>{e.marginalLongTermPct}% federal</dd>
            {e.lossDeducted > 0 && <><dt>Loss used vs. income</dt><dd>{fmtUsd(e.lossDeducted)}</dd></>}
            {e.lossCarryforward > 0 && <><dt>Loss carried to next year</dt><dd>{fmtUsd(e.lossCarryforward)}</dd></>}
            <dt>Federal income tax (all income)</dt><dd>{fmtUsd(e.federalTax)}</dd>
          </dl>
        </Panel>
      </div>

      {isCurrent && <Insights r={r} />}

      <Panel title="By ticker" sub={`${r.year} realized + dividends, and unrealized now`}>
        {r.bySymbol.length ? (
          <div className="table-wrap">
            <table className="tax-table">
              <thead><tr><th className="l">Ticker</th><th>Short-term</th><th>Long-term</th><th>Dividends</th><th>Unrealized</th><th>Total</th></tr></thead>
              <tbody>
                {r.bySymbol.map((s) => (
                  <tr key={s.symbol}>
                    <td className="l sym">{displayName(s.symbol)}</td>
                    <Money v={s.shortTerm} /><Money v={s.longTerm} /><Money v={s.dividends} /><Money v={s.unrealized} /><Money v={s.total} bold />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted pad">No trades or dividends in {r.year}.</p>}
      </Panel>

      <RealizedLots lots={r.realized.lots} year={r.year} />
      <OpenLots r={r} />
      <Dividends r={r} onChanged={load} />

      <p className="tax-disclaimer muted small">
        Estimates only, not tax advice. Uses US federal brackets from <code>config/tax-rules.json</code> (check them against
        irs.gov), FIFO lots, a flat state rate and simplified netting. It doesn't cover AMT, state brackets, Section 1256
        contracts, short sales, or basis adjustments from wash sales. Confirm with your broker's 1099-B and a tax professional.
      </p>
    </div>
  );
}

function Card({ title, value, t, lines, hint, accent }: { title: string; value: string; t: string; lines: string[]; hint: string; accent?: boolean }) {
  return (
    <div className={`tax-card ${accent ? "accent" : ""}`} title={hint}>
      <div className="tax-card-title">{title}</div>
      <div className={`tax-card-value ${t}`}>{value}</div>
      {lines.filter(Boolean).map((l, i) => <div key={i} className="muted small">{l}</div>)}
    </div>
  );
}

function Panel({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="panel tax-panel">
      <div className="tax-panel-head"><h2>{title}</h2>{sub && <span className="muted small">{sub}</span>}</div>
      {children}
    </section>
  );
}

const Money = ({ v, bold }: { v: number | null; bold?: boolean }) => (
  <td className={`num ${tone(v ?? 0)}`}>{v === null ? "—" : v === 0 ? <span className="muted">—</span> : bold ? <b>{fmtSignedUsd(v)}</b> : fmtSignedUsd(v)}</td>
);

const TermBadge = ({ term }: { term: Term }) => <span className={`term ${term}`}>{term === "short" ? "Short" : "Long"}</span>;

// ------------------------------------------------------------------------------ profile

function ProfileForm({ profile, standard, onSaved }: { profile: TaxProfile; standard: number; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => toDraft(profile));
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setDraft(toDraft(profile)); }, [profile]);

  const save = async (patch: Partial<TaxProfile>) => {
    try {
      await api.saveTaxProfile(patch);
      dirty.current = false;
      onSaved();
    } catch (e) {
      toast(errText(e), "err");
    }
  };
  const num = (s: string) => (s.trim() === "" ? 0 : Number(s.replace(/[$,\s]/g, "")));
  const field = (key: "otherIncome" | "stateRatePct" | "lossCarryover" | "deduction", label: string, help: string, suffix?: string) => (
    <label className="field">
      <span>{label}</span>
      <span className="input-affix">
        {!suffix && <i>$</i>}
        <input inputMode="decimal" value={draft[key]} placeholder={key === "deduction" ? `Standard (${fmtUsd(standard).replace(".00", "")})` : "0"}
          onChange={(ev) => { dirty.current = true; setDraft({ ...draft, [key]: ev.target.value }); }}
          onBlur={() => {
            const raw = draft[key];
            const v = key === "deduction" && raw.trim() === "" ? null : num(raw);
            if (v !== null && !Number.isFinite(v)) { toast(`${label}: enter a number`, "err"); return; }
            void save({ [key]: v });
          }}
          onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
        {suffix && <i>{suffix}</i>}
      </span>
      <small className="muted">{help}</small>
    </label>
  );

  return (
    <div className="tax-profile">
      <label className="field">
        <span>Filing status</span>
        <select value={profile.filingStatus} onChange={(ev) => void save({ filingStatus: ev.target.value as FilingStatus })}>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {field("otherIncome", "Other income this year", "Wages, salary, interest, etc. before deductions")}
      {field("deduction", "Deduction", "Leave empty for the standard deduction")}
      {field("stateRatePct", "State tax rate", "Flat % applied to investment income (0 if none)", "%")}
      {field("lossCarryover", "Loss carried over", "Unused capital loss from previous years")}
    </div>
  );
}

const toDraft = (p: TaxProfile) => ({
  otherIncome: p.otherIncome ? String(p.otherIncome) : "",
  deduction: p.deduction === null ? "" : String(p.deduction),
  stateRatePct: p.stateRatePct ? String(p.stateRatePct) : "",
  lossCarryover: p.lossCarryover ? String(p.lossCarryover) : "",
});

// ------------------------------------------------------------------------------ brackets

function BracketBar({ label, brackets, from, to, marginal, stacked }: {
  label: string; brackets: Bracket[]; from: number; to: number; marginal: number; stacked?: boolean;
}) {
  const lastTop = brackets[brackets.length - 2]?.to ?? brackets[0].to ?? 1;
  const max = Math.max(lastTop * 1.15, to * 1.05, 1);
  const x = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className="bracket">
      <div className="bracket-label"><span>{label}</span><b>{marginal}% marginal</b></div>
      <div className="bracket-bar">
        {brackets.map((b, i) => {
          const end = Math.min(b.to ?? max, max);
          const active = to > b.from && (stacked ? end > from : true);
          const wide = ((end - b.from) / max) * 100 >= 4.5; // room for the label
          return (
            <div key={i} className={`seg ${active ? "on" : ""}`} style={{ left: x(b.from), width: `calc(${x(end)} - ${x(b.from)})` }}
              title={`${pct(b.rate)}: ${fmtUsd(b.from)} – ${b.to === null ? "and up" : fmtUsd(b.to)}`}>
              {wide && <span>{pct(b.rate)}</span>}
            </div>
          );
        })}
        {to > from && <div className="fill" style={{ left: x(from), width: `calc(${x(to)} - ${x(from)})` }} />}
        <div className="marker" style={{ left: x(to) }} />
      </div>
      <div className="bracket-scale muted small">
        <span>{stacked && from > 0 ? `starts at ${fmtUsd(from)} (on top of ordinary income)` : "$0"}</span>
        <span>{fmtUsd(to)} taxable</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------ insights

function Insights({ r }: { r: TaxReport }) {
  const soon = r.unrealized.lots.filter((l) => l.term === "short" && l.daysToLongTerm <= 60 && (l.gain ?? 0) > 0)
    .sort((a, b) => a.daysToLongTerm - b.daysToLongTerm).slice(0, 5);
  const harvest = r.unrealized.lots.filter((l) => (l.gain ?? 0) < 0).sort((a, b) => (a.gain ?? 0) - (b.gain ?? 0)).slice(0, 5);
  const wash = r.realized.lots.filter((l) => l.washDisallowed > 0);
  const delta = r.ifSoldToday.taxOnInvestments - r.estimate.taxOnInvestments;
  const st = r.estimate.marginalOrdinaryPct, lt = r.estimate.marginalLongTermPct;
  const saving = (g: number) => (g * (st - lt)) / 100;

  return (
    <Panel title="Things to consider" sub="Based on today's prices">
      <ul className="tax-insights">
        <li>
          <b>If you sold everything today:</b> estimated tax on trading would be {fmtSignedUsd(r.ifSoldToday.taxOnInvestments)}{" "}
          (<span className={delta > 0 ? "down" : delta < 0 ? "up" : ""}>{fmtSignedUsd(delta)}</span> vs. now).
        </li>
        {soon.map((l, i) => (
          <li key={`s${i}`}>
            <b>{displayName(l.symbol)}</b> ({fmtQty(l.qty)} bought {fmtDate(l.acquired)}) turns long-term on {fmtDate(l.longTermOn)},
            in {l.daysToLongTerm} day{l.daysToLongTerm === 1 ? "" : "s"}. Waiting could cut the federal rate on its {fmtUsd(l.gain ?? 0)} gain
            from {st}% to {lt}% (≈ {fmtUsd(saving(l.gain ?? 0))} saved).
          </li>
        ))}
        {harvest.map((l, i) => (
          <li key={`h${i}`}>
            <b>{displayName(l.symbol)}</b> lot is down {fmtSignedUsd(l.gain ?? 0)}. Selling would realize a {l.term}-term loss that offsets
            gains. Buying it back within 30 days makes it a wash sale (loss not deductible yet).
          </li>
        ))}
        {wash.length > 0 && (
          <li>
            <b>{wash.length} wash sale{wash.length === 1 ? "" : "s"}</b> in {r.year}: {fmtUsd(wash.reduce((s, l) => s + l.washDisallowed, 0))} of
            losses can't be deducted this year because you re-bought within 30 days (marked W below).
          </li>
        )}
        {!soon.length && !harvest.length && !wash.length && <li className="muted">No holding-period or loss-harvesting notes right now.</li>}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------------------ lots

function RealizedLots({ lots, year }: { lots: ClosedLot[]; year: number }) {
  const [filter, setFilter] = useState<"all" | Term>("all");
  const shown = useMemo(() => (filter === "all" ? lots : lots.filter((l) => l.term === filter)), [lots, filter]);
  return (
    <Panel title={`Realized lots, ${year}`} sub="Each sale matched to the shares it closed (FIFO)">
      <div className="tax-filter seg small">
        {(["all", "short", "long"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "all" ? `All (${lots.length})` : `${f === "short" ? "Short" : "Long"}-term (${lots.filter((l) => l.term === f).length})`}
          </button>
        ))}
      </div>
      {shown.length ? (
        <div className="table-wrap tall">
          <table className="tax-table">
            <thead><tr>
              <th className="l">Security</th><th>Qty</th><th>Bought</th><th>Sold</th><th>Held</th><th className="c">Term</th>
              <th>Proceeds</th><th>Cost basis</th><th>Gain / loss</th><th title="Wash-sale loss disallowed">Wash (W)</th>
            </tr></thead>
            <tbody>
              {shown.map((l, i) => (
                <tr key={i}>
                  <td className="l sym">{displayName(l.symbol)}</td>
                  <td className="num">{fmtQty(l.qty)}</td>
                  <td className="num">{fmtDate(l.acquired)}</td>
                  <td className="num">{fmtDate(l.sold)}</td>
                  <td className="num muted">{l.daysHeld}d</td>
                  <td className="c"><TermBadge term={l.term} /></td>
                  <td className="num">{fmtUsd(l.proceeds)}</td>
                  <td className="num">{fmtUsd(l.cost)}</td>
                  <Money v={l.gain} />
                  <td className="num">{l.washDisallowed ? <span className="wash" title="Loss disallowed: re-bought within 30 days">W {fmtUsd(l.washDisallowed)}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted pad">No sales {filter === "all" ? "" : `(${filter}-term) `}in {year}.</p>}
    </Panel>
  );
}

function OpenLots({ r }: { r: TaxReport }) {
  const lots = r.unrealized.lots;
  return (
    <Panel title="Open lots (unrealized)" sub="What you hold now, by purchase. Short-term lots become long-term the day after their 1-year anniversary.">
      {lots.length ? (
        <div className="table-wrap tall">
          <table className="tax-table">
            <thead><tr>
              <th className="l">Security</th><th>Qty</th><th>Bought</th><th>Cost</th><th>Price now</th><th>Value</th>
              <th>Gain / loss</th><th className="c">Term</th><th>Long-term from</th>
            </tr></thead>
            <tbody>
              {lots.map((l, i) => (
                <tr key={i}>
                  <td className="l sym">{displayName(l.symbol)}</td>
                  <td className="num">{fmtQty(l.qty)}</td>
                  <td className="num">{fmtDate(l.acquired)}</td>
                  <td className="num">{fmtUsd(l.cost)}</td>
                  <td className="num">{l.mark === null ? "—" : l.mark.toFixed(2)}</td>
                  <td className="num">{fmtUsd(l.value ?? undefined)}</td>
                  <td className={`num ${tone(l.gain ?? 0)}`}>
                    {fmtSignedUsd(l.gain ?? undefined)}
                    {l.gain !== null && l.cost > 0 && <div className="sub">{fmtPct((l.gain / l.cost) * 100)}</div>}
                  </td>
                  <td className="c"><TermBadge term={l.term} /></td>
                  <td className="num">{l.term === "long" ? <span className="muted">already</span> : <>{fmtDate(l.longTermOn)}<div className="sub muted">in {l.daysToLongTerm}d</div></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted pad">You don't hold anything right now.</p>}
    </Panel>
  );
}

// ------------------------------------------------------------------------------ dividends

function Dividends({ r, onChanged }: { r: TaxReport; onChanged: () => void }) {
  const [form, setForm] = useState({ symbol: "", date: r.today, amount: "", qualified: true });
  const [busy, setBusy] = useState(false);
  const add = async (ev: FormEvent) => {
    ev.preventDefault();
    const amount = Number(form.amount.replace(/[$,\s]/g, ""));
    if (!form.symbol.trim() || !(amount > 0)) { toast("Enter a ticker and an amount", "err"); return; }
    setBusy(true);
    try {
      await api.addDividend({ symbol: form.symbol.trim().toUpperCase(), date: form.date, amount, qualified: form.qualified });
      setForm({ ...form, symbol: "", amount: "" });
      onChanged();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={`Dividends, ${r.year}`} sub="The paper account doesn't pay dividends, so record them here. A connected broker can fill these in later.">
      <form className="div-form" onSubmit={add}>
        <input placeholder="Ticker" value={form.symbol} maxLength={12} onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
        <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <span className="input-affix"><i>$</i><input inputMode="decimal" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></span>
        <label className="check" title="Most US stock dividends held 60+ days are qualified (taxed at long-term rates). REIT and money-market payouts usually aren't.">
          <input type="checkbox" checked={form.qualified} onChange={(e) => setForm({ ...form, qualified: e.target.checked })} /> Qualified
        </label>
        <button className="btn primary" disabled={busy}>Add dividend</button>
      </form>
      {r.dividends.items.length ? (
        <div className="table-wrap">
          <table className="tax-table">
            <thead><tr><th className="l">Ticker</th><th>Paid</th><th>Amount</th><th className="c">Type</th><th /></tr></thead>
            <tbody>
              {r.dividends.items.map((d) => (
                <tr key={d.id}>
                  <td className="l sym">{d.symbol}</td>
                  <td className="num">{fmtDate(d.date)}</td>
                  <td className="num up">{fmtUsd(d.amount)}</td>
                  <td className="c"><span className={`term ${d.qualified ? "long" : "short"}`}>{d.qualified ? "Qualified" : "Ordinary"}</span></td>
                  <td className="c">
                    <button className="icon-btn subtle" title="Delete" onClick={async () => {
                      try { await api.deleteDividend(d.id); onChanged(); } catch (e) { toast(errText(e), "err"); }
                    }}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted pad">No dividends recorded for {r.year}.</p>}
    </Panel>
  );
}

// ------------------------------------------------------------------------------ CSV

function exportCsv(r: TaxReport) {
  const esc = (v: string | number) => {
    const s = String(v);
    // Quote, and neutralise spreadsheet formulas (CSV injection).
    return `"${(/^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const rows: (string | number)[][] = [["Description", "Date acquired", "Date sold", "Proceeds", "Cost basis", "Code", "Adjustment", "Gain or loss", "Term"]];
  for (const l of [...r.realized.lots].sort((a, b) => a.soldTs - b.soldTs)) {
    rows.push([`${fmtQty(l.qty)} ${displayName(l.symbol)}`, l.acquired, l.sold, l.proceeds.toFixed(2), l.cost.toFixed(2),
      l.washDisallowed ? "W" : "", l.washDisallowed ? l.washDisallowed.toFixed(2) : "", (l.gain + l.washDisallowed).toFixed(2),
      l.term === "short" ? "Short-term" : "Long-term"]);
  }
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `form-8949-${r.year}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

