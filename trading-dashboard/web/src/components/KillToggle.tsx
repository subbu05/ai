import { useApp, actions } from "../lib/store";

/**
 * Per-ticker kill-switch toggle (automatic profit protection for this one stock).
 * Shown on every watchlist row (it can be set before you buy). While the master switch is off, it's shown dimmed:
 * the ticker keeps its own setting, but nothing sells until the master is back on.
 */
export function KillToggle({ symbol }: { symbol: string }) {
  const master = useApp((s) => s.settings?.profitGuard.enabled ?? false);
  const on = useApp((s) => !(s.settings?.profitGuard.disabledSymbols ?? []).includes(symbol));
  const active = master && on;
  const title = !master
    ? `Kill switch is OFF for all positions (turn it on in the header). ${symbol} is set to ${on ? "ON" : "OFF"}.`
    : on
      ? `Kill switch ON for ${symbol}: sells automatically to lock in profit. Click to turn off for ${symbol}.`
      : `Kill switch OFF for ${symbol}: it won't be sold automatically. Click to turn on.`;
  return (
    <button
      type="button"
      className={`kill-toggle switch ${active ? "on" : "off"} ${master ? "" : "master-off"}`}
      title={title}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        void actions.setKillSwitchFor(symbol, !on);
      }}
    >
      <span className="knob" /><span className="kt-label">{on ? "ON" : "OFF"}</span>
    </button>
  );
}
