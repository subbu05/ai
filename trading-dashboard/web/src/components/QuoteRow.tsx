import { memo } from "react";
import { useQuote } from "../lib/quotes";
import { useApp, actions } from "../lib/store";
import { fmtPrice, fmtSigned, fmtPct, fmtQty, tone } from "../lib/format";

/**
 * A single watchlist row. Subscribes only to its own symbol's quote; a price change
 * re-renders just this <tr>. The flash animation restarts on every tick by alternating
 * between two identical keyframe classes (no effects or timers needed).
 */
export const QuoteRow = memo(function QuoteRow({ symbol, widgetId }: { symbol: string; widgetId: string }) {
  const q = useQuote(symbol);
  const inst = useApp((s) => s.instruments[symbol]);
  const held = useApp((s) => s.positions.find((p) => p.symbol === symbol)?.qty);

  const chg = q ? q.last - q.prevClose : undefined;
  const pct = q && chg !== undefined ? (chg / q.prevClose) * 100 : undefined;
  const flash = q && q.dir ? `flash-${q.dir > 0 ? "up" : "down"}${q.ts % 2}` : "";

  return (
    <tr>
      <td className="l sym" title={inst?.name ?? symbol}>
        <span className="sym-text">{symbol}</span>
        {inst && <span className={`type ${inst.type}`}>{inst.type.toUpperCase()}</span>}
        {held ? <span className="held" title="Shares held">{fmtQty(held)}</span> : null}
        <div className="sym-name">{inst?.name !== symbol ? inst?.name : ""}</div>
      </td>
      <td className={`num price ${flash}`}>{fmtPrice(q?.last)}</td>
      <td className={`num ${tone(chg)}`}>{fmtSigned(chg)}</td>
      <td className="num">
        <span className={`pill ${tone(pct)}`}>{fmtPct(pct)}</span>
      </td>
      <td className="num muted hide-sm">{q ? `${fmtPrice(q.bid)} × ${fmtPrice(q.ask)}` : "—"}</td>
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
