import { memo, useEffect, useState, useRef } from "react";
import type { Widget } from "../lib/types";
import { actions } from "../lib/store";
import { getQuote } from "../lib/quotes";
import { QuoteRow } from "./QuoteRow";
import { SymbolSearch } from "./SymbolSearch";

const SORT_LABELS: Record<NonNullable<Widget["sort"]>, string> = {
  manual: "Manual", symbol: "Symbol", change: "% Change", price: "Price",
};

/**
 * One watchlist widget. Rows subscribe to their own quotes, so this component only
 * re-renders when the widget itself changes. For value-based sorts, the order is
 * recomputed once a second instead of on every tick to keep rows from jumping around.
 */
export const WidgetCard = memo(function WidgetCard({ widget }: { widget: Widget }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(widget.title);
  const [dragOver, setDragOver] = useState(false);
  const order = useSortedSymbols(widget);

  useEffect(() => setTitle(widget.title), [widget.title]);

  const commitTitle = () => {
    setEditing(false);
    const t = title.trim();
    if (t && t !== widget.title) void actions.patchWidget(widget.id, { title: t });
    else setTitle(widget.title);
  };

  return (
    <article
      className={`widget ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-widget")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const id = e.dataTransfer.getData("application/x-widget");
        if (id) void actions.moveWidget(id, widget.id);
      }}
    >
      <div
        className="widget-head"
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-widget", widget.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <span className="grip" title="Drag to reorder">⋮⋮</span>
        {editing ? (
          <input
            className="title-input"
            autoFocus
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") { setTitle(widget.title); setEditing(false); }
            }}
          />
        ) : (
          <h2 className="widget-title" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {widget.title}
          </h2>
        )}
        <span className="count">{widget.symbols.length}</span>
        <div className="widget-tools">
          <select
            className="mini-select"
            value={widget.sort ?? "manual"}
            onChange={(e) => void actions.patchWidget(widget.id, { sort: e.target.value as Widget["sort"] })}
            title="Sort by"
          >
            {Object.entries(SORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="icon-btn" title="Rename" onClick={() => setEditing(true)}>✎</button>
          <button className="icon-btn" title={widget.collapsed ? "Expand" : "Collapse"}
            onClick={() => void actions.patchWidget(widget.id, { collapsed: !widget.collapsed })}>
            {widget.collapsed ? "▸" : "▾"}
          </button>
          <button className="icon-btn danger" title="Delete widget"
            onClick={() => { if (confirm(`Delete widget "${widget.title}"?`)) void actions.deleteWidget(widget.id); }}>
            ✕
          </button>
        </div>
      </div>

      {!widget.collapsed && (
        <>
          <SymbolSearch onPick={(s) => void actions.addSymbol(widget.id, s)} exclude={widget.symbols} />
          {widget.symbols.length ? (
            <div className="table-wrap">
              <table className="quotes">
                <thead>
                  <tr>
                    <th className="l">Symbol</th>
                    <th>Last</th>
                    <th>Chg</th>
                    <th>Chg %</th>
                    <th className="hide-sm">Bid × Ask</th>
                    <th className="c">Trade</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {order.map((s) => (
                    <QuoteRow key={s} symbol={s} widgetId={widget.id} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted pad">Add stocks or ETFs with the search box above.</p>
          )}
        </>
      )}
    </article>
  );
});

function useSortedSymbols(widget: Widget): string[] {
  const sort = widget.sort ?? "manual";
  const compute = () => {
    const syms = [...widget.symbols];
    if (sort === "symbol") syms.sort();
    else if (sort === "price") syms.sort((a, b) => (getQuote(b)?.last ?? 0) - (getQuote(a)?.last ?? 0));
    else if (sort === "change") {
      const pct = (s: string) => { const q = getQuote(s); return q ? (q.last - q.prevClose) / q.prevClose : -Infinity; };
      syms.sort((a, b) => pct(b) - pct(a));
    }
    return syms;
  };
  const [order, setOrder] = useState(compute);
  const latest = useRef(compute);
  latest.current = compute;

  useEffect(() => {
    setOrder(latest.current());
    if (sort !== "change" && sort !== "price") return;
    const id = setInterval(() => {
      const next = latest.current();
      setOrder((prev) => (prev.length === next.length && prev.every((s, i) => s === next[i]) ? prev : next));
    }, 1000);
    return () => clearInterval(id);
  }, [sort, widget.symbols]);

  return order;
}
