import { mult } from "../lib/options";
import { displayName } from "../lib/store";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import type { Fill, SymbolPnl } from "../lib/types";
import { fmtDateTime, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, tone } from "../lib/format";

/** Realized P&L by symbol, cumulative realized P&L chart, and the fill history. */
export function HistoryPanel() {
  const version = useApp((s) => s.pnlVersion);
  const [data, setData] = useState<{ bySymbol: SymbolPnl[]; realizedPnl: number } | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.pnl(), api.fills(1000)]).then(([p, f]) => {
      if (alive) { setData(p); setFills(f); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [version]);

  const stats = useMemo(() => {
    const sells = fills.filter((f) => f.side === "sell");
    const wins = sells.filter((f) => f.realizedPnl > 0).length;
    const best = sells.reduce((m, f) => Math.max(m, f.realizedPnl), 0);
    const worst = sells.reduce((m, f) => Math.min(m, f.realizedPnl), 0);
    return { trades: fills.length, closes: sells.length, winRate: sells.length ? (wins / sells.length) * 100 : 0, best, worst };
  }, [fills]);

  if (!data) return <p className="muted pad">Loading…</p>;

  return (
    <div className="history">
      <div className="cards">
        <Card label="Realized P&L" value={fmtSignedUsd(data.realizedPnl)} tone={tone(data.realizedPnl)} />
        <Card label="Fills" value={String(stats.trades)} />
        <Card label="Win rate (sells)" value={stats.closes ? `${stats.winRate.toFixed(0)}%` : "—"} />
        <Card label="Best sell" value={fmtSignedUsd(stats.best)} tone={tone(stats.best)} />
        <Card label="Worst sell" value={fmtSignedUsd(stats.worst)} tone={tone(stats.worst)} />
        <PnlChart fills={fills} />
      </div>

      <div className="history-grid">
        <div>
          <h3>Realized by symbol</h3>
          {data.bySymbol.length === 0 ? <p className="muted">No trades yet.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th className="l">Symbol</th><th>Bought</th><th>Sold</th><th>Buy value</th><th>Sell value</th><th>Realized</th><th>W / L</th></tr></thead>
                <tbody>
                  {data.bySymbol.map((r) => (
                    <tr key={r.symbol}>
                      <td className="l sym"><span className="sym-text">{r.symbol}</span></td>
                      <td className="num">{fmtQty(r.boughtQty)}</td>
                      <td className="num">{fmtQty(r.soldQty)}</td>
                      <td className="num">{fmtUsd(r.buyValue)}</td>
                      <td className="num">{fmtUsd(r.sellValue)}</td>
                      <td className={`num ${tone(r.realizedPnl)}`}>{fmtSignedUsd(r.realizedPnl)}</td>
                      <td className="num muted">{r.wins} / {r.losses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h3>Fills</h3>
          {fills.length === 0 ? <p className="muted">No fills yet.</p> : (
            <div className="table-wrap scroll">
              <table className="data">
                <thead><tr><th className="l">Time</th><th className="l">Symbol</th><th className="l">Side</th><th>Qty</th><th>Price</th><th>Value</th><th>Realized</th></tr></thead>
                <tbody>
                  {fills.slice(0, 300).map((f) => (
                    <tr key={f.id}>
                      <td className="l muted">{fmtDateTime(f.ts)}</td>
                      <td className="l sym"><span className="sym-text">{displayName(f.symbol)}</span></td>
                      <td className={`l ${f.side === "buy" ? "up" : "down"}`}>{f.side.toUpperCase()}</td>
                      <td className="num">{fmtQty(f.qty)}</td>
                      <td className="num">{fmtPrice(f.price)}</td>
                      <td className="num">{fmtUsd(f.qty * f.price * mult(f.symbol))}</td>
                      <td className={`num ${tone(f.realizedPnl)}`}>{f.side === "sell" ? fmtSignedUsd(f.realizedPnl) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, tone: t }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${t ?? ""}`}>{value}</div>
    </div>
  );
}

/** Cumulative realized P&L as a lightweight inline SVG line. */
function PnlChart({ fills }: { fills: Fill[] }) {
  const pts = useMemo(() => {
    const sells = fills.filter((f) => f.side === "sell").sort((a, b) => a.ts - b.ts);
    let cum = 0;
    return [0, ...sells.map((f) => (cum += f.realizedPnl))];
  }, [fills]);
  if (pts.length < 2) return null;
  const W = 240, H = 56, pad = 4;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <div className="card chart-card">
      <div className="stat-label">Cumulative realized</div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative realized P&L">
        <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} className="zero" />
        <path d={d} className={`line ${tone(last)}`} />
      </svg>
    </div>
  );
}
