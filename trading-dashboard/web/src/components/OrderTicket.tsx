import { useEffect, useMemo, useState } from "react";
import { useApp, actions } from "../lib/store";
import { useQuote } from "../lib/quotes";
import { fmtPct, fmtPrice, fmtQty, fmtUsd, tone } from "../lib/format";
import type { OrderType, Side, TimeInForce } from "../lib/types";

const TYPES: { id: OrderType; label: string }[] = [
  { id: "market", label: "Market" },
  { id: "limit", label: "Limit" },
  { id: "stop", label: "Stop" },
  { id: "stop_limit", label: "Stop limit" },
];

export function OrderTicket() {
  const ticket = useApp((s) => s.ticket)!;
  const broker = useApp((s) => s.broker);
  const account = useApp((s) => s.account);
  const inst = useApp((s) => s.instruments[ticket.symbol]);
  const position = useApp((s) => s.positions.find((p) => p.symbol === ticket.symbol));
  const q = useQuote(ticket.symbol);

  const [side, setSide] = useState<Side>(ticket.side);
  const [type, setType] = useState<OrderType>("market");
  const [qtyMode, setQtyMode] = useState<"shares" | "dollars">("shares");
  const [qty, setQty] = useState(ticket.qty ? String(ticket.qty) : "1");
  const [limit, setLimit] = useState("");
  const [stop, setStop] = useState("");
  const [tif, setTif] = useState<TimeInForce>("day");
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState(false);

  // Prefill limit/stop with the current touch price when switching type/side.
  useEffect(() => {
    if (!q) return;
    const touch = side === "buy" ? q.ask : q.bid;
    if (type === "limit" || type === "stop_limit") setLimit(touch.toFixed(2));
    if (type === "stop" || type === "stop_limit") setStop((side === "buy" ? q.last * 1.01 : q.last * 0.99).toFixed(2));
    // only on type/side change, not every tick
  }, [type, side]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && actions.closeTicket();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needsLimit = type === "limit" || type === "stop_limit";
  const needsStop = type === "stop" || type === "stop_limit";
  const refPrice = needsLimit ? Number(limit) : needsStop ? Number(stop) : side === "buy" ? q?.ask : q?.bid;

  const shares = useMemo(() => {
    const n = Number(qty);
    if (!(n > 0)) return 0;
    if (qtyMode === "shares") return n;
    return refPrice ? Math.floor((n / refPrice) * 1e6) / 1e6 : 0;
  }, [qty, qtyMode, refPrice]);

  const est = refPrice ? shares * refPrice : 0;
  const held = position?.qty ?? 0;
  const problems: string[] = [];
  if (!(shares > 0)) problems.push("Enter a quantity");
  if (needsLimit && !(Number(limit) > 0)) problems.push("Enter a limit price");
  if (needsStop && !(Number(stop) > 0)) problems.push("Enter a stop price");
  if (side === "sell" && shares > held + 1e-9) problems.push(`You hold ${fmtQty(held)} shares`);
  if (side === "buy" && account && est > account.buyingPower + 1e-9) problems.push("Exceeds buying power");
  if (broker?.live && !confirmLive) problems.push("Confirm live order");

  const chg = q ? q.last - q.prevClose : 0;
  const pct = q ? (chg / q.prevClose) * 100 : 0;
  const unreal = q && position ? (q.last - position.avgCost) * position.qty : undefined;

  const submit = async () => {
    if (problems.length || busy) return;
    setBusy(true);
    const ok = await actions.placeOrder({
      symbol: ticket.symbol, side, type, qty: shares, tif,
      limitPrice: needsLimit ? Number(limit) : undefined,
      stopPrice: needsStop ? Number(stop) : undefined,
    });
    setBusy(false);
    if (ok) actions.closeTicket();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && actions.closeTicket()}>
      <form className={`modal ticket ${side}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="ticket-head">
          <div>
            <div className="ticket-sym">
              {ticket.symbol} {inst && <span className={`type ${inst.type}`}>{inst.type.toUpperCase()}</span>}
            </div>
            <div className="muted small">{inst?.name}</div>
          </div>
          <div className="ticket-quote">
            <div className="big">{fmtPrice(q?.last)}</div>
            <div className={tone(pct)}>{fmtPct(pct)}</div>
          </div>
          <button type="button" className="icon-btn" onClick={actions.closeTicket} aria-label="Close">✕</button>
        </div>

        <div className="quote-strip">
          <span>Bid <b>{fmtPrice(q?.bid)}</b></span>
          <span>Ask <b>{fmtPrice(q?.ask)}</b></span>
          <span>High <b>{fmtPrice(q?.high)}</b></span>
          <span>Low <b>{fmtPrice(q?.low)}</b></span>
        </div>

        <div className="seg">
          <button type="button" className={side === "buy" ? "on buy" : ""} onClick={() => setSide("buy")}>Buy</button>
          <button type="button" className={side === "sell" ? "on sell" : ""} onClick={() => { setSide("sell"); if (held) setQty(String(held)); setQtyMode("shares"); }} disabled={!held}>Sell</button>
        </div>

        <label className="field">
          <span>Order type</span>
          <div className="seg small">
            {TYPES.map((t) => (
              <button type="button" key={t.id} className={type === t.id ? "on" : ""} onClick={() => setType(t.id)}>{t.label}</button>
            ))}
          </div>
        </label>

        <label className="field">
          <span>
            Quantity
            <span className="link-toggle">
              <button type="button" className={qtyMode === "shares" ? "on" : ""} onClick={() => setQtyMode("shares")}>shares</button>
              <button type="button" className={qtyMode === "dollars" ? "on" : ""} onClick={() => setQtyMode("dollars")}>dollars</button>
            </span>
          </span>
          <div className="row">
            <input autoFocus type="number" inputMode="decimal" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
            {side === "sell" && held > 0 && <button type="button" className="btn sm" onClick={() => { setQtyMode("shares"); setQty(String(held)); }}>Max</button>}
          </div>
          {qtyMode === "dollars" && <small className="muted">≈ {fmtQty(shares)} shares</small>}
        </label>

        {needsStop && (
          <label className="field">
            <span>Stop price</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={stop} onChange={(e) => setStop(e.target.value)} />
          </label>
        )}
        {needsLimit && (
          <label className="field">
            <span>Limit price</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
        )}
        {type !== "market" && (
          <label className="field">
            <span>Time in force</span>
            <select value={tif} onChange={(e) => setTif(e.target.value as TimeInForce)}>
              <option value="day">Day</option>
              <option value="gtc">Good till cancelled</option>
            </select>
          </label>
        )}

        <dl className="summary">
          <dt>Estimated {side === "buy" ? "cost" : "proceeds"}</dt><dd>{fmtUsd(est)}</dd>
          <dt>Buying power</dt><dd>{fmtUsd(account?.buyingPower)}</dd>
          <dt>Shares held</dt><dd>{fmtQty(held)}{position && ` @ ${fmtPrice(position.avgCost)}`}</dd>
          {unreal !== undefined && (<><dt>Unrealized P&L</dt><dd className={tone(unreal)}>{fmtUsd(unreal)}</dd></>)}
        </dl>

        {broker?.live && (
          <label className="live-confirm">
            <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
            This is a <b>real-money</b> order on {broker.name}.
          </label>
        )}

        <button type="submit" className={`btn block ${side}`} disabled={problems.length > 0 || busy}>
          {busy ? "Sending…" : problems[0] ?? `${side === "buy" ? "Buy" : "Sell"} ${fmtQty(shares)} ${ticket.symbol}`}
        </button>
      </form>
    </div>
  );
}
