import { memo, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApp, actions, store } from "../lib/store";
import { getQuote, useQuote, useQuotesVersion } from "../lib/quotes";
import type { GuardStatus, Position } from "../lib/types";
import { KillToggle } from "./KillToggle";
import { fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, tone } from "../lib/format";

/** Profit-guard state (today's peak, trigger price) lives on the server; poll it while visible. */
function useGuard(): Map<string, GuardStatus> {
  const version = useApp((s) => s.pnlVersion);
  const [map, setMap] = useState(new Map<string, GuardStatus>());
  useEffect(() => {
    let alive = true;
    const load = () => api.profitGuard().then((g) => alive && setMap(new Map(g.positions.map((p) => [p.symbol, p])))).catch(() => {});
    void load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [version]);
  return map;
}

export function PositionsTable() {
  const positions = useApp((s) => s.positions);
  const guard = useGuard();
  if (!positions.length) return <p className="muted pad">No open positions. Use Buy on any widget row to open one.</p>;
  const sorted = [...positions].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th className="l">Symbol</th>
            <th>Qty</th>
            <th>Avg cost</th>
            <th>Last</th>
            <th>Market value</th>
            <th>Day P&L</th>
            <th>Unrealized P&L</th>
            <th>Unrealized %</th>
            <th title="Realized on closed trades in this ticker (all time)">Realized</th>
            <th title="Unrealized + realized">Total P&L</th>
            <th title="Automatic kill switch for this ticker, and the price that would trigger it">Kill switch</th>
            <th className="c">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => <PositionRow key={p.symbol} p={p} g={guard.get(p.symbol)} />)}
        </tbody>
        <Totals positions={positions} />
      </table>
    </div>
  );
}

const PositionRow = memo(function PositionRow({ p, g }: { p: Position; g?: GuardStatus }) {
  const guardOn = useApp((s) => s.settings?.profitGuard.enabled);
  const realized = useApp((s) => s.realized[p.symbol]) ?? p.realizedPnl;
  const q = useQuote(p.symbol);
  const name = useApp((s) => s.instruments[p.symbol]?.name);
  const last = q?.last;
  const mv = last !== undefined ? p.qty * last : undefined;
  const cost = p.qty * p.avgCost;
  const unreal = mv !== undefined ? mv - cost : undefined;
  const day = q ? p.qty * (q.last - q.prevClose) : undefined;
  const total = unreal !== undefined ? unreal + realized : undefined;
  return (
    <tr>
      <td className="l sym" title={name}><span className="sym-text">{p.symbol}</span><div className="sym-name">{name !== p.symbol ? name : ""}</div></td>
      <td className="num">{fmtQty(p.qty)}</td>
      <td className="num">{fmtPrice(p.avgCost)}</td>
      <td className="num">{fmtPrice(last)}</td>
      <td className="num">{fmtUsd(mv)}</td>
      <td className={`num ${tone(day)}`}>{fmtSignedUsd(day)}</td>
      <td className={`num ${tone(unreal)}`}>{fmtSignedUsd(unreal)}</td>
      <td className="num"><span className={`pill ${tone(unreal)}`}>{unreal !== undefined ? fmtPct((unreal / cost) * 100) : "—"}</span></td>
      <td className={`num ${tone(realized)}`}>{fmtSignedUsd(realized)}</td>
      <td className={`num ${tone(total)}`}><b>{fmtSignedUsd(total)}</b></td>
      <td className="num guard-cell">
        <KillToggle symbol={p.symbol} />{" "}
        {!guardOn || g?.enabled === false ? null
          : g?.triggered ? <span className="near">selling…</span>
          : g?.triggerPrice != null ? (
            <span title={`Today's high ${fmtPrice(g.peak)} · cost ${fmtPrice(g.avgCost)}`}>
              <span className={`tp ${last !== undefined && last <= g.triggerPrice * 1.01 ? "near" : ""}`}>{fmtPrice(g.triggerPrice)}</span>
            </span>
          ) : <span className="muted" title="Arms once the position is in profit today">not in profit</span>}
      </td>
      <td className="c actions">
        <button className="btn buy sm" onClick={() => actions.openTicket(p.symbol, "buy")}>Buy</button>
        <button className="btn sell sm" onClick={() => actions.openTicket(p.symbol, "sell", p.qty)}>Sell</button>
        <button className="btn kill sm" title={`Sell all ${p.symbol} at market now`} onClick={() => store.set({ kill: [p.symbol] })}>Exit</button>
      </td>
    </tr>
  );
});

function Totals({ positions }: { positions: Position[] }) {
  const v = useQuotesVersion();
  const realizedMap = useApp((s) => s.realized);
  const t = useMemo(() => {
    let mv = 0, cost = 0, day = 0, realized = 0;
    for (const p of positions) {
      const q = getQuote(p.symbol);
      mv += p.qty * (q?.last ?? p.avgCost);
      cost += p.qty * p.avgCost;
      day += q ? p.qty * (q.last - q.prevClose) : 0;
      realized += realizedMap[p.symbol] ?? p.realizedPnl;
    }
    return { mv, cost, day, realized, unreal: mv - cost };
  }, [positions, v, realizedMap]);
  return (
    <tfoot>
      <tr>
        <td className="l"><b>Total</b></td>
        <td /><td className="num muted">{fmtUsd(t.cost)}</td><td />
        <td className="num"><b>{fmtUsd(t.mv)}</b></td>
        <td className={`num ${tone(t.day)}`}>{fmtSignedUsd(t.day)}</td>
        <td className={`num ${tone(t.unreal)}`}><b>{fmtSignedUsd(t.unreal)}</b></td>
        <td className="num"><span className={`pill ${tone(t.unreal)}`}>{t.cost ? fmtPct((t.unreal / t.cost) * 100) : "—"}</span></td>
        <td className={`num ${tone(t.realized)}`}>{fmtSignedUsd(t.realized)}</td>
        <td className={`num ${tone(t.unreal + t.realized)}`}><b>{fmtSignedUsd(t.unreal + t.realized)}</b></td>
        <td /><td />
      </tr>
    </tfoot>
  );
}
