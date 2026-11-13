import { memo, useMemo } from "react";
import { useApp, actions } from "../lib/store";
import { getQuote, useQuote, useQuotesVersion } from "../lib/quotes";
import type { Position } from "../lib/types";
import { fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, tone } from "../lib/format";

export function PositionsTable() {
  const positions = useApp((s) => s.positions);
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
            <th>Realized</th>
            <th className="c">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => <PositionRow key={p.symbol} p={p} />)}
        </tbody>
        <Totals positions={positions} />
      </table>
    </div>
  );
}

const PositionRow = memo(function PositionRow({ p }: { p: Position }) {
  const q = useQuote(p.symbol);
  const name = useApp((s) => s.instruments[p.symbol]?.name);
  const last = q?.last;
  const mv = last !== undefined ? p.qty * last : undefined;
  const cost = p.qty * p.avgCost;
  const unreal = mv !== undefined ? mv - cost : undefined;
  const day = q ? p.qty * (q.last - q.prevClose) : undefined;
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
      <td className={`num ${tone(p.realizedPnl)}`}>{fmtSignedUsd(p.realizedPnl)}</td>
      <td className="c actions">
        <button className="btn buy sm" onClick={() => actions.openTicket(p.symbol, "buy")}>Buy</button>
        <button className="btn sell sm" onClick={() => actions.openTicket(p.symbol, "sell", p.qty)}>Sell</button>
      </td>
    </tr>
  );
});

function Totals({ positions }: { positions: Position[] }) {
  const v = useQuotesVersion();
  const t = useMemo(() => {
    let mv = 0, cost = 0, day = 0, realized = 0;
    for (const p of positions) {
      const q = getQuote(p.symbol);
      mv += p.qty * (q?.last ?? p.avgCost);
      cost += p.qty * p.avgCost;
      day += q ? p.qty * (q.last - q.prevClose) : 0;
      realized += p.realizedPnl;
    }
    return { mv, cost, day, realized, unreal: mv - cost };
  }, [positions, v]);
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
        <td />
      </tr>
    </tfoot>
  );
}
