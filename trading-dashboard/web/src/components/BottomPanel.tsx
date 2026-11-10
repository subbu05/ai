import { useState } from "react";
import { useApp } from "../lib/store";
import { PositionsTable } from "./PositionsTable";
import { OrdersTable } from "./OrdersTable";
import { HistoryPanel } from "./HistoryPanel";

type Tab = "positions" | "orders" | "history";

export function BottomPanel() {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem("td.tab") as Tab) || "positions");
  const nPos = useApp((s) => s.positions.length);
  const nOpen = useApp((s) => s.orders.reduce((n, o) => n + (o.status === "open" ? 1 : 0), 0));

  const select = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem("td.tab", t); } catch { /* storage unavailable */ }
  };

  return (
    <section className="panel">
      <nav className="tabs">
        <button className={tab === "positions" ? "on" : ""} onClick={() => select("positions")}>Positions <span className="count">{nPos}</span></button>
        <button className={tab === "orders" ? "on" : ""} onClick={() => select("orders")}>Orders {nOpen > 0 && <span className="count hot">{nOpen} open</span>}</button>
        <button className={tab === "history" ? "on" : ""} onClick={() => select("history")}>P&L / History</button>
      </nav>
      <div className="panel-body">
        {tab === "positions" && <PositionsTable />}
        {tab === "orders" && <OrdersTable />}
        {tab === "history" && <HistoryPanel />}
      </div>
    </section>
  );
}
