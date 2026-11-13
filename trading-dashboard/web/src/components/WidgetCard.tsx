import { memo, useEffect, useState, useRef } from "react";
import type { Widget } from "../lib/types";
import { actions } from "../lib/store";
import { getQuote } from "../lib/quotes";
import { QuoteRow } from "./QuoteRow";
import { SymbolSearch } from "./SymbolSearch";
import { WidgetShell } from "./WidgetShell";
import { OptionsWidget } from "./OptionsWidget";

const SORT_LABELS: Record<NonNullable<Widget["sort"]>, string> = {
  manual: "Manual", symbol: "Symbol", change: "% Change", price: "Price",
};

/** Picks the widget body by kind: a stock/ETF watchlist or an option chain. */
export const WidgetCard = memo(function WidgetCard({ widget }: { widget: Widget }) {
  return widget.kind === "options" && widget.options ? <OptionsWidget widget={widget} /> : <QuotesWidget widget={widget} />;
});

/**
 * Watchlist widget. Rows subscribe to their own quotes, so this component only
 * re-renders when the widget itself changes. For value-based sorts, the order is
 * recomputed once a second instead of on every tick to keep rows from jumping around.
 */
function QuotesWidget({ widget }: { widget: Widget }) {
  const order = useSortedSymbols(widget);

  return (
    <WidgetShell
      widget={widget}
      count={widget.symbols.length}
      tools={
        <select
          className="mini-select"
          value={widget.sort ?? "manual"}
          onChange={(e) => void actions.patchWidget(widget.id, { sort: e.target.value as Widget["sort"] })}
          title="Sort by"
        >
          {Object.entries(SORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      }
    >
      <SymbolSearch onPick={(s) => void actions.addSymbol(widget.id, s)} exclude={widget.symbols} />
      {widget.symbols.length ? (
        <div className="table-wrap">
          <table className="quotes">
            <thead>
              <tr>
                <th className="l">Symbol</th>
                <th title="Your average purchase price and how many you hold">Bought at</th>
                <th>Last</th>
                <th>Day chg</th>
                <th title="Realized + unrealized P&L for this ticker">Total P&L</th>
                <th className="hide-narrow">Bid × Ask</th>
                <th className="c auto-col" title="Kill switch for this ticker: when ON, it is sold automatically to protect profit"><span className="long">Auto-sell</span><span className="short">🛡</span></th>
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
    </WidgetShell>
  );
}

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
