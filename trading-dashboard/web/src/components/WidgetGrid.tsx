import { useApp, actions } from "../lib/store";
import { WidgetCard } from "./WidgetCard";

export function WidgetGrid() {
  const widgets = useApp((s) => s.widgets);
  if (!widgets.length) {
    return (
      <section className="empty-grid">
        <p>No widgets yet.</p>
        <button className="btn primary" onClick={() => void actions.addWidget("Watchlist")}>+ Create your first widget</button>
      </section>
    );
  }
  return (
    <section className="grid">
      {widgets.map((w) => (
        <WidgetCard key={w.id} widget={w} />
      ))}
    </section>
  );
}
