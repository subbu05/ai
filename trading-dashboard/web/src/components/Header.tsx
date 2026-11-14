import { useMemo } from "react";
import { useApp, store, actions } from "../lib/store";
import { getQuote, useQuotesVersion } from "../lib/quotes";
import { markPrice, mult } from "../lib/options";
import { fmtSignedUsd, fmtUsd, tone, fmtPct } from "../lib/format";
import { usePage, goTo } from "../lib/route";

/** Account summary bar. Re-computes live totals at most once per animation frame. */
export function Header() {
  const broker = useApp((s) => s.broker);
  const provider = useApp((s) => s.provider);
  const conn = useApp((s) => s.conn);
  const account = useApp((s) => s.account);
  const positions = useApp((s) => s.positions);
  const guard = useApp((s) => s.settings?.profitGuard);
  const v = useQuotesVersion();
  const page = usePage();

  const t = useMemo(() => {
    let mv = 0, cost = 0, day = 0;
    for (const p of positions) {
      const q = getQuote(p.symbol);
      const m = mult(p.symbol);
      const mark = markPrice(q, p.symbol) ?? p.avgCost;
      mv += p.qty * mark * m;
      cost += p.qty * p.avgCost * m;
      if (q) day += p.qty * (mark - q.prevClose) * m;
    }
    return { mv, cost, day, unrealized: mv - cost };
  }, [positions, v]);

  const equity = (account?.cash ?? 0) + t.mv;
  const totalPnl = account ? equity - account.startingCash : 0;

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">▲</span> Trading Dashboard
        {broker && <span className={`badge ${broker.live ? "live" : "paper"}`}>{broker.live ? "LIVE" : "PAPER"} · {broker.name}</span>}
        <span className={`conn ${conn}`} title={`Stream ${conn} · data: ${provider}`} />
        <nav className="page-tabs" aria-label="Pages">
          <button className={page === "trade" ? "on" : ""} aria-current={page === "trade" ? "page" : undefined} onClick={() => goTo("trade")}>Trading</button>
          <button className={page === "taxes" ? "on" : ""} aria-current={page === "taxes" ? "page" : undefined} onClick={() => goTo("taxes")}>P&amp;L &amp; Taxes</button>
        </nav>
        {provider === "simulated" && <span className="badge muted-badge" title="Prices are simulated. Configure a real market data provider to see live prices.">simulated data</span>}
      </div>

      <div className="stats">
        <Stat label="Equity" value={fmtUsd(equity)} />
        <Stat label="Day P&L" value={fmtSignedUsd(t.day)} tone={tone(t.day)} />
        <Stat label="Unrealized" value={fmtSignedUsd(t.unrealized)} tone={tone(t.unrealized)}
          sub={t.cost ? fmtPct((t.unrealized / t.cost) * 100) : undefined} />
        <Stat label="Realized" value={fmtSignedUsd(account?.realizedPnl)} tone={tone(account?.realizedPnl)} />
        <Stat label="Total P&L" value={fmtSignedUsd(totalPnl)} tone={tone(totalPnl)}
          sub={account ? fmtPct((totalPnl / account.startingCash) * 100) : undefined} />
        <Stat label="Cash" value={fmtUsd(account?.cash)} />
        <Stat label="Buying power" value={fmtUsd(account?.buyingPower)} />
      </div>

      <div className="header-actions">
        {guard && (
          <button
            className={`master-toggle ${guard.enabled ? "on" : "off"}`}
            role="switch"
            aria-checked={guard.enabled}
            onClick={() => void actions.setKillSwitch(!guard.enabled)}
            title={guard.enabled
              ? `Kill switch ON: any position that has been in profit today is sold if it falls ${guard.dropPct}% from today's high, never below cost + ${guard.floorPct}%. Click to turn off.`
              : "Kill switch OFF: nothing is sold automatically. Click to turn on."}
          >
            <span className="knob" />
            🛡 Kill switch {guard.enabled ? `ON · ${guard.dropPct}%` : "OFF"}
          </button>
        )}
        <button className="btn kill" disabled={!positions.length} onClick={() => store.set({ kill: "all" })}
          title="Cancel all open orders and sell every position at market right now">⛔ Sell all now</button>
        {page === "trade" && <button className="btn primary" onClick={() => void actions.addWidget()} title="Add a watchlist of stocks / ETFs">+ Widget</button>}
        {page === "trade" && <button className="btn" onClick={() => void actions.addOptionsWidget()} title="Add an option chain widget (calls, puts, Greeks)">+ Options</button>}
        <button className="btn" onClick={() => store.set({ settingsOpen: true })} title="Settings">⚙ Settings</button>
      </div>
    </header>
  );
}

function Stat({ label, value, tone: t, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${t ?? ""}`}>
        {value}
        {sub && <span className="stat-sub">{sub}</span>}
      </div>
    </div>
  );
}
