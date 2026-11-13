import { createStore } from "./createStore";
import { api } from "./api";
import { ingestQuotes } from "./quotes";
import { parseOcc, contractShort } from "./options";
import type { Account, BrokerRef, Instrument, Order, OrderRequest, Position, PublicSettings, Side, Widget } from "./types";

export interface Ticket {
  symbol: string;
  side: Side;
  qty?: number;
}

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

interface AppState {
  ready: boolean;
  error: string | null;
  conn: "connecting" | "open" | "closed";
  broker: BrokerRef | null;
  provider: string;
  settings: PublicSettings | null;
  widgets: Widget[];
  account: Account | null;
  positions: Position[];
  orders: Order[];
  instruments: Record<string, Instrument>;
  ticket: Ticket | null;
  settingsOpen: boolean;
  /** Kill-switch confirmation: null = closed, "all" = everything, or specific tickers. */
  kill: "all" | string[] | null;
  toasts: Toast[];
  /** Lifetime realized P&L per symbol (from all fills, including closed positions). */
  realized: Record<string, number>;
  /** Bumped whenever fills may have changed, so P&L views refetch. */
  pnlVersion: number;
  /** Option contracts each visible options widget needs streamed. */
  chainSubs: Record<string, string[]>;
}

export const store = createStore<AppState>({
  ready: false,
  error: null,
  conn: "connecting",
  broker: null,
  provider: "",
  settings: null,
  widgets: [],
  account: null,
  positions: [],
  orders: [],
  instruments: {},
  ticket: null,
  settingsOpen: false,
  kill: null,
  toasts: [],
  realized: {},
  pnlVersion: 0,
  chainSubs: {},
});

export const useApp = store.useStore;

let toastSeq = 0;
export function toast(text: string, kind: Toast["kind"] = "info"): void {
  const t = { id: ++toastSeq, kind, text };
  store.set((s) => ({ toasts: [...s.toasts, t].slice(-5) }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), kind === "err" ? 6000 : 3500);
}

/** Ticker, or a short contract name for options ("AAPL $230C Nov 20"). */
export function displayName(symbol: string): string {
  const c = parseOcc(symbol);
  return c ? contractShort(c) : symbol;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let realizedSeq = 0;
/** Refresh lifetime realized P&L per symbol (cheap; called after fills). */
export async function loadRealized(): Promise<void> {
  const my = ++realizedSeq;
  try {
    const p = await api.pnl();
    if (my === realizedSeq) store.set({ realized: Object.fromEntries(p.bySymbol.map((r) => [r.symbol, r.realizedPnl])) });
  } catch { /* keep previous */ }
}

/** Fetch instrument names/types for symbols we haven't seen yet. */
async function ensureInstruments(symbols: string[]): Promise<void> {
  const known = store.get().instruments;
  const missing = symbols.filter((s) => !known[s]);
  if (!missing.length) return;
  const got = await api.instruments(missing);
  store.set((s) => ({ instruments: { ...s.instruments, ...got } }));
}

export const actions = {
  async bootstrap(): Promise<void> {
    try {
      const b = await api.bootstrap();
      store.set({
        ready: true, error: null, broker: b.broker, provider: b.provider, settings: b.settings,
        widgets: b.widgets, account: b.account, positions: b.positions, orders: b.orders,
        instruments: { ...store.get().instruments, ...b.instruments },
      });
      void loadRealized();
    } catch (e) {
      store.set({ error: errText(e) });
    }
  },

  async refreshTrading(): Promise<void> {
    const [account, positions, orders] = await Promise.all([api.account(), api.positions(), api.orders()]);
    store.set((s) => ({ account, positions, orders, pnlVersion: s.pnlVersion + 1 }));
    void loadRealized();
    void ensureInstruments(positions.map((p) => p.symbol));
  },

  // ---- widgets (optimistic: update UI first, roll back on error)
  async addWidget(title = "New widget"): Promise<void> {
    try {
      const w = await api.createWidget(title);
      store.set((s) => ({ widgets: [...s.widgets, w] }));
    } catch (e) {
      toast(errText(e), "err");
    }
  },

  async addOptionsWidget(underlying = "SPY"): Promise<void> {
    try {
      const w = await api.createOptionsWidget(underlying);
      store.set((s) => ({ widgets: [...s.widgets, w] }));
      requestAnimationFrame(() => document.getElementById(`w-${w.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      toast(errText(e), "err");
    }
  },

  setChainSubs(widgetId: string, symbols: string[] | null): void {
    store.set((s) => {
      const next = { ...s.chainSubs };
      if (symbols) next[widgetId] = symbols;
      else delete next[widgetId];
      return { chainSubs: next };
    });
  },

  async patchWidget(id: string, patch: Partial<Widget>): Promise<void> {
    const before = store.get().widgets;
    store.set({ widgets: before.map((w) => (w.id === id ? { ...w, ...patch } : w)) });
    try {
      const saved = await api.updateWidget(id, patch);
      store.set((s) => ({ widgets: s.widgets.map((w) => (w.id === id ? saved : w)) }));
    } catch (e) {
      store.set({ widgets: before });
      toast(errText(e), "err");
    }
  },

  async addSymbol(id: string, symbol: string): Promise<void> {
    const w = store.get().widgets.find((x) => x.id === id);
    if (!w) return;
    const sym = symbol.trim().toUpperCase();
    if (w.symbols.includes(sym)) return toast(`${sym} is already in ${w.title}`);
    await actions.patchWidget(id, { symbols: [...w.symbols, sym] });
    void ensureInstruments([sym]);
    api.quotes([sym]).then(ingestQuotes).catch(() => {});
  },

  removeSymbol(id: string, symbol: string): Promise<void> {
    const w = store.get().widgets.find((x) => x.id === id);
    return w ? actions.patchWidget(id, { symbols: w.symbols.filter((s) => s !== symbol) }) : Promise.resolve();
  },

  async deleteWidget(id: string): Promise<void> {
    const before = store.get().widgets;
    store.set({ widgets: before.filter((w) => w.id !== id) });
    try {
      await api.deleteWidget(id);
    } catch (e) {
      store.set({ widgets: before });
      toast(errText(e), "err");
    }
  },

  async moveWidget(dragId: string, targetId: string): Promise<void> {
    const list = [...store.get().widgets];
    const from = list.findIndex((w) => w.id === dragId);
    const to = list.findIndex((w) => w.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const [w] = list.splice(from, 1);
    list.splice(to, 0, w);
    store.set({ widgets: list });
    try {
      await api.reorderWidgets(list.map((x) => x.id));
    } catch (e) {
      toast(errText(e), "err");
    }
  },

  // ---- trading
  openTicket(symbol: string, side: Side, qty?: number): void {
    store.set({ ticket: { symbol, side, qty } });
  },
  closeTicket(): void {
    store.set({ ticket: null });
  },

  async placeOrder(o: OrderRequest): Promise<boolean> {
    try {
      const order = await api.placeOrder(o);
      upsertOrder(order);
      if (order.status === "rejected") {
        toast(`Rejected: ${order.reason ?? "unknown reason"}`, "err");
        return false;
      }
      const what = displayName(order.symbol);
      toast(
        order.status === "filled"
          ? `Filled: ${order.side.toUpperCase()} ${order.qty} ${what} @ ${order.avgFillPrice?.toFixed(2)}`
          : `Order placed: ${order.side.toUpperCase()} ${order.qty} ${what} (${order.type.replace("_", " ")})`,
        "ok",
      );
      return true;
    } catch (e) {
      toast(errText(e), "err");
      return false;
    }
  },

  /** Master on/off for the automatic kill switch (profit protection). */
  async setKillSwitch(enabled: boolean): Promise<void> {
    try {
      const r = await api.updateSettings({ profitGuard: { enabled } });
      store.set({ settings: r.settings });
      toast(enabled ? "🛡 Kill switch ON: positions are protected" : "Kill switch OFF: nothing will be sold automatically", enabled ? "ok" : "info");
    } catch (e) {
      toast(errText(e), "err");
    }
  },

  /** Per-ticker on/off. */
  async setKillSwitchFor(symbol: string, enabled: boolean): Promise<void> {
    try {
      const pg = await api.setKillSwitchFor(symbol, enabled);
      store.set((s) => ({ settings: s.settings ? { ...s.settings, profitGuard: pg } : s.settings }));
      toast(`🛡 Kill switch ${enabled ? "ON" : "OFF"} for ${symbol}`, enabled ? "ok" : "info");
    } catch (e) {
      toast(errText(e), "err");
    }
  },

  /** Execute the manual "sell now" (after the user confirmed). */
  async killSwitch(scope: "all" | string[]): Promise<boolean> {
    try {
      const r = await api.killSwitch(scope === "all" ? undefined : scope);
      await actions.refreshTrading();
      const failed = r.results.filter((x) => x.status !== "filled");
      if (!r.results.length) toast(`Nothing to sell${r.cancelledOrders ? ` (cancelled ${r.cancelledOrders} open orders)` : ""}`, "info");
      else toast(`⛔ Sold ${r.results.length - failed.length} position(s). Locked in ${r.realizedPnl >= 0 ? "+" : "−"}$${Math.abs(r.realizedPnl).toFixed(2)}`
        + (failed.length ? `. ${failed.length} failed: ${failed.map((f) => `${f.symbol} (${f.message ?? f.status})`).join(", ")}` : ""),
        failed.length ? "err" : "ok");
      return true;
    } catch (e) {
      toast(errText(e), "err");
      return false;
    }
  },

  async cancelOrder(id: string): Promise<void> {
    try {
      upsertOrder(await api.cancelOrder(id));
    } catch (e) {
      toast(errText(e), "err");
    }
  },
};

export function upsertOrder(o: Order): void {
  store.set((s) => {
    const i = s.orders.findIndex((x) => x.id === o.id);
    if (i < 0) return { orders: [o, ...s.orders] };
    if (s.orders[i].updatedAt > o.updatedAt) return {};
    const orders = s.orders.slice();
    orders[i] = o;
    return { orders };
  });
}

export function setPortfolio(account: Account, positions: Position[]): void {
  store.set((s) => ({ account, positions, pnlVersion: s.pnlVersion + 1 }));
  void loadRealized();
  void ensureInstruments(positions.map((p) => p.symbol));
}
