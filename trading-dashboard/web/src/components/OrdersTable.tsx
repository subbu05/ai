import { displayName } from "../lib/store";
import { useState } from "react";
import { useApp, actions } from "../lib/store";
import { fmtDateTime, fmtPrice, fmtQty } from "../lib/format";
import type { Order } from "../lib/types";

export function OrdersTable() {
  const orders = useApp((s) => s.orders);
  const [filter, setFilter] = useState<"open" | "all">("all");
  const list = filter === "open" ? orders.filter((o) => o.status === "open") : orders;

  return (
    <>
      <div className="panel-tools">
        <div className="seg small">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
          <button className={filter === "open" ? "on" : ""} onClick={() => setFilter("open")}>Open</button>
        </div>
      </div>
      {list.length === 0 ? (
        <p className="muted pad">No {filter === "open" ? "open " : ""}orders.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="l">Time</th><th className="l">Symbol</th><th className="l">Side</th><th className="l">Type</th>
                <th>Qty</th><th>Limit</th><th>Stop</th><th>Fill price</th><th className="l">Status</th><th />
              </tr>
            </thead>
            <tbody>
              {list.map((o) => <OrderRow key={o.id} o={o} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function OrderRow({ o }: { o: Order }) {
  return (
    <tr className={o.status}>
      <td className="l muted">{fmtDateTime(o.createdAt)}</td>
      <td className="l sym"><span className="sym-text">{displayName(o.symbol)}</span>{o.source === "profit-guard" && <span className="auto" title="Sold automatically by profit protection">🛡 auto</span>}
        {o.source === "kill-switch" && <span className="auto killed" title="Sold by the kill switch">⛔ kill</span>}
        {o.source === "expiry" && <span className="auto" title={o.reason ?? "Settled at expiration"}>⏱ expired</span>}</td>
      <td className={`l ${o.side === "buy" ? "up" : "down"}`}>{o.side.toUpperCase()}</td>
      <td className="l">{o.type.replace("_", " ")}{o.tif === "gtc" ? " · GTC" : ""}{o.triggered && o.status === "open" ? " (triggered)" : ""}</td>
      <td className="num">{fmtQty(o.qty)}</td>
      <td className="num">{o.limitPrice ? fmtPrice(o.limitPrice) : "—"}</td>
      <td className="num">{o.stopPrice ? fmtPrice(o.stopPrice) : "—"}</td>
      <td className="num">{o.avgFillPrice ? fmtPrice(o.avgFillPrice) : "—"}</td>
      <td className="l"><span className={`status ${o.status}`} title={o.reason}>{o.status}</span>{o.reason && <span className="muted small"> {o.reason}</span>}</td>
      <td className="c">{o.status === "open" && <button className="btn sm" onClick={() => void actions.cancelOrder(o.id)}>Cancel</button>}</td>
    </tr>
  );
}
