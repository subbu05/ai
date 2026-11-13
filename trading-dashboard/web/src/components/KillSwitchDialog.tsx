import { useEffect, useMemo, useState } from "react";
import { useApp, store, actions } from "../lib/store";
import { getQuote, useQuotesVersion } from "../lib/quotes";
import { fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, tone } from "../lib/format";

/**
 * Confirmation for the kill switch. Shows, live, what you'd lock in: each position's
 * estimated exit at the current bid and the resulting P&L. One click to execute.
 */
export function KillSwitchDialog() {
  const scope = useApp((s) => s.kill)!;
  const positions = useApp((s) => s.positions);
  const orders = useApp((s) => s.orders);
  const broker = useApp((s) => s.broker);
  const v = useQuotesVersion();
  const [busy, setBusy] = useState(false);
  const close = () => store.set({ kill: null });

  const inScope = (sym: string) => scope === "all" || scope.includes(sym);
  const rows = useMemo(
    () =>
      positions.filter((p) => inScope(p.symbol)).map((p) => {
        const bid = getQuote(p.symbol)?.bid;
        return { ...p, bid, value: bid !== undefined ? bid * p.qty : undefined, pnl: bid !== undefined ? (bid - p.avgCost) * p.qty : undefined };
      }),
    // v: recompute on every quote frame so the estimate stays live
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positions, scope, v],
  );
  const total = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const proceeds = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const nOrders = orders.filter((o) => o.status === "open" && inScope(o.symbol)).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = async () => {
    setBusy(true);
    const ok = await actions.killSwitch(scope);
    setBusy(false);
    if (ok) close();
  };

  const what = rows.length === 1 ? "this position" : `all ${rows.length} positions`;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal killsw">
        <div className="ticket-head">
          <h2>⛔ {scope === "all" ? "Sell everything now" : `Exit ${scope.join(", ")}`}</h2>
          <button className="icon-btn" onClick={close} aria-label="Close">✕</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {nOrders > 0 ? `Cancels ${nOrders} open order${nOrders > 1 ? "s" : ""}, then sells ${what}` : `Sells ${what}`} immediately
          at market. You keep whatever profit or loss each one has right now. Estimates use the current bid.
        </p>
        {rows.length > 0 && (
          <table className="data">
            <thead>
              <tr><th className="l">Symbol</th><th>Qty</th><th>Paid</th><th>Bid</th><th>P&L</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol}>
                  <td className="l sym"><span className="sym-text">{r.symbol}</span></td>
                  <td className="num">{fmtQty(r.qty)}</td>
                  <td className="num">{fmtPrice(r.avgCost)}</td>
                  <td className="num">{fmtPrice(r.bid)}</td>
                  <td className={`num ${tone(r.pnl)}`}>{fmtSignedUsd(r.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="kill-total">
          <span>Locks in ≈ <span className="muted small">(proceeds {fmtUsd(proceeds)})</span></span>
          <span className={`stat-value ${tone(total)}`}>{fmtSignedUsd(total)}</span>
        </div>
        {broker?.live && <p className="note">This sells real positions on {broker.name}.</p>}
        <button className="btn block kill" autoFocus disabled={busy || rows.length === 0} onClick={() => void run()}>
          {busy ? "Selling…" : rows.length ? `Sell ${rows.length === 1 ? rows[0].symbol : `all ${rows.length} positions`} now` : "No positions to sell"}
        </button>
      </div>
    </div>
  );
}
