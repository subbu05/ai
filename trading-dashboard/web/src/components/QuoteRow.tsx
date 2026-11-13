import { memo } from "react";
import { useQuote } from "../lib/quotes";
import { useApp, actions } from "../lib/store";
import { KillToggle } from "./KillToggle";
import { mult } from "../lib/options";
import { fmtPrice, fmtSigned, fmtSignedUsd, fmtPct, fmtQty, tone } from "../lib/format";

/**
 * A single watchlist row. Subscribes only to its own symbol's quote; a price change
 * re-renders just this <tr>. The flash animation restarts on every tick by alternating
 * between two identical keyframe classes (no effects or timers needed).
 */
export const QuoteRow = memo(function QuoteRow({ symbol, widgetId }: { symbol: string; widgetId: string }) {
  const q = useQuote(symbol);
  const inst = useApp((s) => s.instruments[symbol]);
  const pos = useApp((s) => s.positions.find((p) => p.symbol === symbol));
  const realized = useApp((s) => s.realized[symbol]);
  const held = pos?.qty;

  const chg = q ? q.last - q.prevClose : undefined;
  const pct = q && chg !== undefined ? (chg / q.prevClose) * 100 : undefined;
  // Total P&L for this ticker = lifetime realized (closed trades) + unrealized on shares held now.
  const unreal = pos && q ? (q.last - pos.avgCost) * pos.qty * mult(symbol) : undefined;
  const hasPnl = realized !== undefined || unreal !== undefined;
  const total = hasPnl ? (realized ?? 0) + (unreal ?? 0) : undefined;
  const vsPaid = pos && q ? ((q.last - pos.avgCost) / pos.avgCost) * 100 : undefined;
  const flash = q && q.dir ? `flash-${q.dir > 0 ? "up" : "down"}${q.ts % 2}` : "";

  return (
    <tr>
      <td className="l sym" title={inst?.name ?? symbol}>
        <span className="sym-text">{symbol}</span>
        {inst && <span className={`type ${inst.type}`}>{inst.type.toUpperCase()}</span>}
        {held ? <span className="held" title="Shares held">{fmtQty(held)}</span> : null}
        <div className="sym-name">{inst?.name !== symbol ? inst?.name : ""}</div>
      </td>
      <td className="num paid" title={pos ? `Your average purchase price for ${fmtQty(pos.qty)} shares` : "Not held"}>
        {pos ? <>{fmtPrice(pos.avgCost)}<div className="sub muted">{fmtQty(pos.qty)} {mult(symbol) > 1 ? "ct" : "sh"}</div></> : <span className="muted">—</span>}
      </td>
      <td className={`num price ${flash}`}>
        {fmtPrice(q?.last)}
        {vsPaid !== undefined && <div className={`sub ${tone(vsPaid)}`} title="Last price vs your purchase price">{fmtPct(vsPaid)} vs paid</div>}
      </td>
      <td className="num">
        <span className={`pill ${tone(pct)}`}>{fmtPct(pct)}</span>
        <div className={`sub ${tone(chg)}`}>{fmtSigned(chg)}</div>
      </td>
      <td className={`num ${tone(total)}`}
        title={hasPnl ? `Unrealized ${fmtSignedUsd(unreal ?? 0)} + realized ${fmtSignedUsd(realized ?? 0)}` : "No trades in this ticker"}>
        {hasPnl ? <b>{fmtSignedUsd(total)}</b> : <span className="muted">—</span>}
      </td>
      <td className="num muted hide-narrow">{q ? `${fmtPrice(q.bid)} × ${fmtPrice(q.ask)}` : "—"}</td>
      <td className="c guard-cell"><KillToggle symbol={symbol} /></td>
      <td className="c actions">
        <button className="btn buy sm" onClick={() => actions.openTicket(symbol, "buy")}>Buy</button>
        <button className="btn sell sm" onClick={() => actions.openTicket(symbol, "sell", held)} disabled={!held}>Sell</button>
      </td>
      <td className="c">
        <button className="icon-btn subtle" title={`Remove ${symbol}`} onClick={() => void actions.removeSymbol(widgetId, symbol)}>×</button>
      </td>
    </tr>
  );
});
