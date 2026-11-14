import { useApp, actions } from "./lib/store";
import { Header } from "./components/Header";
import { WidgetGrid } from "./components/WidgetGrid";
import { BottomPanel } from "./components/BottomPanel";
import { OrderTicket } from "./components/OrderTicket";
import { SettingsModal } from "./components/SettingsModal";
import { Toasts } from "./components/Toasts";
import { KillSwitchDialog } from "./components/KillSwitchDialog";
import { TaxPage } from "./components/TaxPage";
import { usePage } from "./lib/route";

export function App() {
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
  const hasTicket = useApp((s) => s.ticket !== null);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const kill = useApp((s) => s.kill !== null);
  const page = usePage();

  if (!ready) {
    return (
      <div className="splash">
        {error ? (
          <>
            <p>Can't reach the local server: {error}</p>
            <p className="muted">Start it with <code>npm run dev</code> (or <code>npm start</code>) in the trading-dashboard folder.</p>
            <button className="btn" onClick={() => void actions.bootstrap()}>Retry</button>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <Header />
      {page === "taxes" ? (
        <main className="main"><TaxPage /></main>
      ) : (
        <main className="main">
          <WidgetGrid />
          <BottomPanel />
        </main>
      )}
      {hasTicket && <OrderTicket />}
      {settingsOpen && <SettingsModal />}
      {kill && <KillSwitchDialog />}
      <Toasts />
    </div>
  );
}
