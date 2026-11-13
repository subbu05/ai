import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { OptionChain, OptionsWidgetConfig, Widget } from "../lib/types";
import { api } from "../lib/api";
import { actions, useApp } from "../lib/store";
import { getQuote, ingestQuotes, useQuote, useQuotesVersion } from "../lib/quotes";
import { analyze, contractLabel, fmtExpiry, parseOcc } from "../lib/options";
import { fmtCompact, fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, tone } from "../lib/format";
import { WidgetShell } from "./WidgetShell";
import { SymbolSearch } from "./SymbolSearch";

type ColKey = "bid" | "ask" | "chg" | "vol" | "oi" | "iv" | "delta" | "gamma" | "theta" | "vega";
interface Col { k: ColKey; label: string; title: string; greek?: boolean }

/** Put-side order (bid/ask next to the strike); the call side is mirrored. */
const COLS: Col[] = [
  { k: "bid", label: "Bid", title: "Bid: what buyers pay right now (what you'd get selling). Click to sell if you hold it, otherwise to buy." },
  { k: "ask", label: "Ask", title: "Ask: what sellers want right now (what you'd pay buying). Click to buy." },
  { k: "chg", label: "Chg %", title: "Change in the option's price vs yesterday's close" },
  { k: "vol", label: "Vol", title: "Volume: contracts traded today. Higher = easier to get filled near the mid" },
  { k: "oi", label: "OI", title: "Open interest: contracts currently open. Shows where traders are positioned" },
  { k: "iv", label: "IV", title: "Implied volatility: the yearly move priced in. Higher IV = more expensive options" },
  { k: "delta", label: "Δ", greek: true, title: "Delta: option price change for a $1 move in the stock. |Δ| ≈ chance of finishing in the money" },
  { k: "gamma", label: "Γ", greek: true, title: "Gamma: how much delta changes for a $1 move in the stock" },
  { k: "theta", label: "Θ", greek: true, title: "Theta: value lost per day from time decay (per share; ×100 per contract)" },
  { k: "vega", label: "Vega", greek: true, title: "Vega: price change for a 1-point change in implied volatility" },
];

const STRIKE_CHOICES = [4, 6, 8, 10, 15, 20];

/** Which columns survive as the widget narrows (first = most important). */
const PRIORITY: ColKey[] = ["bid", "ask", "delta", "iv", "theta", "oi", "chg", "vol", "gamma", "vega"];
const COL_PX = 58, STRIKE_PX = 96;

function visibleCols(width: number, sides: number, greeks: boolean): Col[] {
  const avail = greeks ? COLS : COLS.filter((c) => !c.greek);
  const fit = Math.max(3, Math.floor((width - STRIKE_PX) / (sides * COL_PX)));
  if (fit >= avail.length) return avail;
  const keep = new Set(PRIORITY.filter((k) => avail.some((c) => c.k === k)).slice(0, fit));
  return avail.filter((c) => keep.has(c.k));
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * Option chain widget for one underlying: calls on the left, puts on the right, strikes in
 * the middle, with live bid/ask, % change, volume, open interest, IV and Greeks.
 * Click a strike for decision details (breakeven, time value, chance ITM, theta per contract);
 * click a bid/ask to open the order ticket.
 *
 * Each half-row subscribes only to its own contract's quote, so a tick re-renders one cell
 * group, not the whole chain.
 */
export const OptionsWidget = memo(function OptionsWidget({ widget }: { widget: Widget }) {
  const cfg = widget.options!;
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const active = !widget.collapsed;

  const patch = (p: Partial<OptionsWidgetConfig>) => void actions.patchWidget(widget.id, { options: { ...cfg, ...p } });

  // Load the chain; stream its contracts while the widget is expanded.
  useEffect(() => {
    if (!active) {
      actions.setChainSubs(widget.id, null);
      return;
    }
    let alive = true;
    api.optionChain(cfg.underlying, cfg.expiry, cfg.strikes).then((c) => {
      if (!alive) return;
      ingestQuotes(c.quotes);
      setChain(c);
      setError(null);
      actions.setChainSubs(widget.id, [c.underlying, ...c.calls, ...c.puts]);
    }).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [widget.id, cfg.underlying, cfg.expiry, cfg.strikes, nonce, active]);

  useEffect(() => () => actions.setChainSubs(widget.id, null), [widget.id]);

  // Re-center when the stock moves near the edge of the strikes shown.
  useEffect(() => {
    if (!chain || !active) return;
    const id = setInterval(() => {
      const s = getQuote(chain.underlying)?.last;
      const k = chain.strikes;
      if (s !== undefined && k.length > 4 && (s < k[1] || s > k[k.length - 2])) setNonce((n) => n + 1);
    }, 3000);
    return () => clearInterval(id);
  }, [chain, active]);

  const stale = chain && chain.underlying !== cfg.underlying;

  return (
    <WidgetShell widget={widget} className="options-widget" count={<span title="Option chain">OPTIONS</span>}>
      <div className="opt-toolbar">
        <div className="opt-und">
          <SymbolSearch onPick={(s) => patch({ underlying: s, expiry: undefined })} exclude={[cfg.underlying]} placeholder={`${cfg.underlying} · change stock/ETF…`} />
        </div>
        <label className="opt-ctl" title="Expiration date (DTE = days to expiration; M = monthly, W = weekly)">
          <span>Expiry</span>
          <select className="mini-select" value={chain?.expiry ?? ""} onChange={(e) => patch({ expiry: e.target.value })}>
            {chain?.expirations.map((e) => (
              <option key={e.date} value={e.date}>{fmtExpiry(e.date)} · {e.dte}d {e.kind === "monthly" ? "M" : "W"}</option>
            ))}
          </select>
        </label>
        <label className="opt-ctl" title="Strikes shown on each side of the current price">
          <span>Strikes</span>
          <select className="mini-select" value={cfg.strikes} onChange={(e) => patch({ strikes: Number(e.target.value) })}>
            {[...new Set([...STRIKE_CHOICES, cfg.strikes])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>±{n}</option>)}
          </select>
        </label>
        <div className="seg small opt-view" role="group" aria-label="Show">
          {(["calls", "both", "puts"] as const).map((v) => (
            <button key={v} type="button" className={cfg.view === v ? "on" : ""} onClick={() => patch({ view: v })}>
              {v === "both" ? "Calls + Puts" : v === "calls" ? "Calls" : "Puts"}
            </button>
          ))}
        </div>
        <label className="opt-check" title="Show delta, gamma, theta and vega columns">
          <input type="checkbox" checked={cfg.greeks} onChange={(e) => patch({ greeks: e.target.checked })} /> Greeks
        </label>
        <button className="icon-btn" title="Re-center strikes on the current price" onClick={() => setNonce((n) => n + 1)}>⌖</button>
      </div>

      {error && <p className="pad down">{error}</p>}
      {!chain && !error && <p className="pad muted">Loading {cfg.underlying} options…</p>}
      {chain && !stale && (
        <>
          <ChainStats chain={chain} />
          <ChainTable chain={chain} cfg={cfg} />
          <p className="opt-legend muted">
            Prices are per share; 1 contract = 100 shares. Δ ≈ $ change per $1 stock move · Γ = change in Δ per $1 ·
            Θ = $ lost per day · Vega = $ per 1-pt IV change. Shaded = in the money. Click a strike for breakeven and odds.
          </p>
        </>
      )}
    </WidgetShell>
  );
});

// ------------------------------------------------------------------------------ summary

function ChainStats({ chain }: { chain: OptionChain }) {
  const u = useQuote(chain.underlying);
  const v = useQuotesVersion();
  const s = useMemo(() => {
    const S = u?.last;
    if (S === undefined) return null;
    let atm = 0;
    chain.strikes.forEach((k, i) => { if (Math.abs(k - S) < Math.abs(chain.strikes[atm] - S)) atm = i; });
    const cq = getQuote(chain.calls[atm]), pq = getQuote(chain.puts[atm]);
    const mid = (q?: { bid: number; ask: number }) => (q ? (q.bid + q.ask) / 2 : 0);
    const straddle = mid(cq) + mid(pq);
    const ivs = [cq?.greeks?.iv, pq?.greeks?.iv].filter((x): x is number => x !== undefined);
    let callVol = 0, putVol = 0, callOi = 0, putOi = 0;
    const ois: [number, number, number][] = [];
    chain.strikes.forEach((k, i) => {
      const c = getQuote(chain.calls[i]), p = getQuote(chain.puts[i]);
      callVol += c?.volume ?? 0; putVol += p?.volume ?? 0;
      callOi += c?.oi ?? 0; putOi += p?.oi ?? 0;
      ois.push([k, c?.oi ?? 0, p?.oi ?? 0]);
    });
    // Max pain: the expiry price at which option holders (in total) would collect the least.
    let maxPain = chain.strikes[0], least = Infinity;
    for (const [x] of ois) {
      let pay = 0;
      for (const [k, coi, poi] of ois) pay += coi * Math.max(0, x - k) + poi * Math.max(0, k - x);
      if (pay < least) { least = pay; maxPain = x; }
    }
    return {
      S, chgPct: ((S - u!.prevClose) / u!.prevClose) * 100,
      atmIv: ivs.length ? (ivs.reduce((a, b) => a + b, 0) / ivs.length) * 100 : undefined,
      move: straddle, movePct: (straddle / S) * 100,
      pcVol: callVol ? putVol / callVol : undefined, pcOi: callOi ? putOi / callOi : undefined,
      callVol, putVol, maxPain,
    };
    // v: recompute (at most once per frame) when any contract ticks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, u, v]);

  const exp = chain.expirations.find((e) => e.date === chain.expiry);
  const pcTilt = (r?: number) => (r === undefined ? "" : r > 1.1 ? "more puts: bearish/hedged" : r < 0.7 ? "more calls: bullish" : "balanced");

  return (
    <div className="opt-stats">
      <Stat label={chain.underlying} value={fmtPrice(s?.S)} sub={<span className={tone(s?.chgPct)}>{fmtPct(s?.chgPct)}</span>}
        title="Underlying price and today's change" />
      <Stat label="Expiry" value={fmtExpiry(chain.expiry)} sub={`${chain.dte} DTE${exp ? ` · ${exp.kind}` : ""}`}
        title="Days to expiration. Time decay (theta) speeds up in the last few weeks" />
      <Stat label="ATM IV" value={s?.atmIv !== undefined ? `${s.atmIv.toFixed(1)}%` : "—"}
        title="Implied volatility of the at-the-money options: how big a yearly move the market prices in" />
      <Stat label="Expected move" value={s ? `±${fmtPrice(s.move)}` : "—"}
        sub={s ? `±${s.movePct.toFixed(1)}% · ${fmtPrice(s.S - s.move)}–${fmtPrice(s.S + s.move)}` : undefined}
        title="Price of the at-the-money straddle (call + put): the move the market expects by expiration" />
      <Stat label="Put/Call vol" value={s?.pcVol !== undefined ? s.pcVol.toFixed(2) : "—"} sub={pcTilt(s?.pcVol)}
        title={`Put volume ÷ call volume today (${fmtCompact(s?.putVol ?? 0)} puts / ${fmtCompact(s?.callVol ?? 0)} calls)`} />
      <Stat label="Put/Call OI" value={s?.pcOi !== undefined ? s.pcOi.toFixed(2) : "—"} sub={pcTilt(s?.pcOi)}
        title="Put open interest ÷ call open interest, across the strikes shown" />
      <Stat label="Max pain" value={s ? `$${s.maxPain}` : "—"}
        title="Strike where option holders would collect the least at expiration (from open interest, strikes shown). Some traders watch it as a magnet near expiry." />
    </div>
  );
}

function Stat({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="opt-stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className="opt-stat-value">{value}</div>
      {sub && <div className="opt-stat-sub">{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------ chain table

function ChainTable({ chain, cfg }: { chain: OptionChain; cfg: OptionsWidgetConfig }) {
  const S = useQuote(chain.underlying)?.last;
  const [open, setOpen] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  const showC = cfg.view !== "puts", showP = cfg.view !== "calls";
  const cols = useMemo(() => visibleCols(width, showC && showP ? 2 : 1, cfg.greeks), [width, showC, showP, cfg.greeks]);
  const callCols = useMemo(() => [...cols].reverse(), [cols]);
  const hidden = (cfg.greeks ? COLS : COLS.filter((c) => !c.greek)).length - cols.length;
  const span = (showC ? cols.length : 0) + 1 + (showP ? cols.length : 0);
  const spotAt = S === undefined ? -1 : chain.strikes.findIndex((k) => k > S);

  // Start scrolled so the at-the-money strikes are visible.
  useEffect(() => {
    const el = wrapRef.current?.querySelector<HTMLElement>(".spot-row");
    const wrap = wrapRef.current;
    if (el && wrap) wrap.scrollTop = Math.max(0, el.offsetTop - wrap.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);

  return (
    <div className="table-wrap chain-wrap" ref={wrapRef}>
      <table className={`chain ${cfg.view}`}>
        <thead>
          <tr className="side-head">
            {showC && <th colSpan={cols.length} className="calls-head">CALLS</th>}
            <th className="strike-head" />
            {showP && <th colSpan={cols.length} className="puts-head">PUTS</th>}
          </tr>
          <tr>
            {showC && callCols.map((c) => <th key={`c-${c.k}`} className={`c-${c.k}`} title={c.title}>{c.label}</th>)}
            <th className="strike" title="Strike price: the price at which the option lets you buy (call) or sell (put) the stock">Strike</th>
            {showP && cols.map((c) => <th key={`p-${c.k}`} className={`c-${c.k}`} title={c.title}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {chain.strikes.map((k, i) => (
            <ChainRowGroup
              key={k}
              strike={k}
              callSym={chain.calls[i]}
              putSym={chain.puts[i]}
              itmCall={S !== undefined && k < S}
              itmPut={S !== undefined && k > S}
              callCols={showC ? callCols : null}
              putCols={showP ? cols : null}
              open={open === k}
              onToggle={() => setOpen((o) => (o === k ? null : k))}
              span={span}
              underlying={chain.underlying}
              S={i === spotAt ? S : undefined}
              view={cfg.view}
            />
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <p className="opt-legend muted">{hidden} column{hidden > 1 ? "s" : ""} hidden to fit. Widen the window or show Calls or Puts only to see all.</p>
      )}
    </div>
  );
}

const ChainRowGroup = memo(function ChainRowGroup(props: {
  strike: number; callSym: string; putSym: string; itmCall: boolean; itmPut: boolean;
  callCols: Col[] | null; putCols: Col[] | null; open: boolean; onToggle: () => void;
  span: number; underlying: string; S: number | undefined; view: OptionsWidgetConfig["view"];
}) {
  const { strike, callSym, putSym, itmCall, itmPut, callCols, putCols, open, onToggle, span, underlying, S, view } = props;
  const heldC = useApp((s) => s.positions.find((p) => p.symbol === callSym)?.qty);
  const heldP = useApp((s) => s.positions.find((p) => p.symbol === putSym)?.qty);
  return (
    <>
      {S !== undefined && (
        <tr className="spot-row"><td colSpan={span}><span>▲ {underlying} {fmtPrice(S)}</span></td></tr>
      )}
      <tr className={`chain-row ${open ? "open" : ""}`}>
        {callCols && <SideCells sym={callSym} cols={callCols} itm={itmCall} held={heldC} />}
        <td className={`strike ${itmCall ? "itm-c" : ""} ${itmPut ? "itm-p" : ""}`} onClick={onToggle} title="Click for breakeven, odds and decay">
          {heldC ? <span className="held-badge c" title={`You hold ${heldC} call contract(s)`}>C×{fmtQty(heldC)}</span> : null}
          <b>{strike}</b>
          {heldP ? <span className="held-badge p" title={`You hold ${heldP} put contract(s)`}>P×{fmtQty(heldP)}</span> : null}
        </td>
        {putCols && <SideCells sym={putSym} cols={putCols} itm={itmPut} held={heldP} />}
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={span}>
            <div className="opt-detail">
              {view !== "puts" && <ContractCard sym={callSym} underlying={underlying} held={heldC} />}
              {view !== "calls" && <ContractCard sym={putSym} underlying={underlying} held={heldP} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

function SideCells({ sym, cols, itm, held }: { sym: string; cols: Col[]; itm: boolean; held?: number }) {
  const q = useQuote(sym);
  const g = q?.greeks;
  const chg = q && q.prevClose > 0 ? ((q.last - q.prevClose) / q.prevClose) * 100 : undefined;
  const cls = (k: ColKey) => `num c-${k} ${itm ? "itm" : ""} ${held ? "held" : ""}`;
  return (
    <>
      {cols.map((c) => {
        switch (c.k) {
          case "bid":
            return (
              <td key={c.k} className={cls("bid")}>
                <button className="q-btn sell" title={held ? `Sell (you hold ${held})` : "Buy at a limit"}
                  onClick={() => actions.openTicket(sym, held ? "sell" : "buy", held)}>{fmtPrice(q?.bid)}</button>
              </td>
            );
          case "ask":
            return (
              <td key={c.k} className={cls("ask")}>
                <button className="q-btn buy" title="Buy" onClick={() => actions.openTicket(sym, "buy")}>{fmtPrice(q?.ask)}</button>
              </td>
            );
          case "chg": return <td key={c.k} className={`${cls("chg")} ${tone(chg)}`}>{fmtPct(chg)}</td>;
          case "vol": return <td key={c.k} className={cls("vol")}>{q ? fmtCompact(q.volume) : "—"}</td>;
          case "oi": return <td key={c.k} className={cls("oi")}>{q?.oi !== undefined ? fmtCompact(q.oi) : "—"}</td>;
          case "iv": return <td key={c.k} className={cls("iv")}>{g ? `${(g.iv * 100).toFixed(1)}%` : "—"}</td>;
          case "delta": return <td key={c.k} className={cls("delta")}>{g ? g.delta.toFixed(3) : "—"}</td>;
          case "gamma": return <td key={c.k} className={cls("gamma")}>{g ? g.gamma.toFixed(4) : "—"}</td>;
          case "theta": return <td key={c.k} className={`${cls("theta")} down`}>{g ? g.theta.toFixed(3) : "—"}</td>;
          case "vega": return <td key={c.k} className={cls("vega")}>{g ? g.vega.toFixed(3) : "—"}</td>;
        }
      })}
    </>
  );
}

/** Decision details for one contract: what it costs, what has to happen to make money, and the odds. */
function ContractCard({ sym, underlying, held }: { sym: string; underlying: string; held?: number }) {
  const c = parseOcc(sym)!;
  const q = useQuote(sym);
  const S = useQuote(underlying)?.last;
  const pos = useApp((s) => s.positions.find((p) => p.symbol === sym));
  const a = analyze(c, q, S);
  const isCall = c.right === "C";
  const pnl = pos && q ? (((q.bid + q.ask) / 2) - pos.avgCost) * pos.qty * 100 : undefined;
  return (
    <div className={`opt-card ${isCall ? "call" : "put"}`}>
      <div className="opt-card-head">
        <b>{underlying} {contractLabel(c)}</b>
        {a && <span className={`badge ${a.itm ? "itm" : "otm"}`}>{a.itm ? "In the money" : "Out of the money"}</span>}
      </div>
      {a ? (
        <dl className="opt-facts">
          <dt>Mid / cost per contract</dt><dd>{fmtPrice(a.mid)} · {fmtUsd(a.costPerContract)} <span className="muted">at ask</span></dd>
          <dt title={isCall ? "Strike + premium paid (ask)" : "Strike − premium paid (ask)"}>Breakeven at expiry</dt>
          <dd>{fmtPrice(a.breakeven)} <span className="muted" title="How far the stock must move by expiration for this to break even">({fmtPct(a.moveToBreakeven)} move)</span></dd>
          <dt title="Rough estimate from |delta|">≈ Chance in the money</dt><dd>{a.probItm !== undefined ? `${a.probItm.toFixed(0)}%` : "—"}</dd>
          <dt title="Intrinsic = value if exercised now; time value = the rest, which decays to 0 by expiration">Intrinsic / time value</dt>
          <dd>{fmtPrice(a.intrinsic)} / {fmtPrice(a.timeValue)}</dd>
          <dt title="Theta × 100: what one contract loses per day if nothing else changes">Time decay per contract</dt>
          <dd className="down">{a.thetaPerContract !== undefined ? `${fmtSignedUsd(a.thetaPerContract)}/day` : "—"}</dd>
          <dt title="Delta × 100: dollar change per contract for a $1 move in the stock">$ per $1 stock move</dt>
          <dd>{a.deltaDollars !== undefined ? fmtSignedUsd(a.deltaDollars) : "—"}</dd>
          <dt>Max loss (buyer)</dt><dd className="down">{fmtUsd(a.maxLoss)}</dd>
          <dt>Max profit (buyer)</dt><dd className="up">{Number.isFinite(a.maxProfit) ? fmtUsd(a.maxProfit) : "Unlimited"}</dd>
          <dt title="(ask − bid) ÷ mid. Wide spreads cost you on entry and exit">Bid/ask spread</dt>
          <dd className={a.spreadPct !== undefined && a.spreadPct > 10 ? "down" : ""}>
            {a.spreadPct !== undefined ? `${a.spreadPct.toFixed(1)}%` : "—"}
            {a.spreadPct !== undefined && a.spreadPct > 10 && <span className="muted"> wide: use a limit</span>}
          </dd>
          {pos && (<><dt>Your position</dt><dd>{fmtQty(pos.qty)} @ {fmtPrice(pos.avgCost)} <span className={tone(pnl)}>{fmtSignedUsd(pnl)}</span></dd></>)}
        </dl>
      ) : <p className="muted small">Waiting for quotes…</p>}
      <div className="opt-card-actions">
        <button className="btn buy sm" onClick={() => actions.openTicket(sym, "buy")}>Buy {isCall ? "call" : "put"}</button>
        <button className="btn sell sm" disabled={!held} onClick={() => actions.openTicket(sym, "sell", held)}>Sell</button>
      </div>
    </div>
  );
}
