import { store, setPortfolio, upsertOrder, actions, toast } from "./store";
import { ingestRows } from "./quotes";

/**
 * WebSocket client: reconnects with backoff, and keeps the server-side subscription equal
 * to the symbols currently needed (widgets + positions + open orders).
 */
let socket: WebSocket | null = null;
let attempt = 0;
let lastSubKey = "";

function neededSymbols(): string[] {
  const s = store.get();
  const set = new Set<string>();
  for (const w of s.widgets) for (const sym of w.symbols) set.add(sym);
  for (const p of s.positions) set.add(p.symbol);
  for (const o of s.orders) if (o.status === "open") set.add(o.symbol);
  if (s.ticket) set.add(s.ticket.symbol);
  return [...set].sort();
}

function syncSubs(force = false): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const syms = neededSymbols();
  const key = syms.join(",");
  if (!force && key === lastSubKey) return;
  lastSubKey = key;
  socket.send(JSON.stringify({ t: "sub", symbols: syms }));
}

export function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  store.set({ conn: "connecting" });

  ws.onopen = () => {
    const reconnect = attempt > 0;
    attempt = 0;
    store.set({ conn: "open" });
    syncSubs(true);
    if (reconnect) void actions.refreshTrading().catch(() => {});
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    switch (msg.t) {
      case "q":
        ingestRows(msg.d);
        break;
      case "order":
        upsertOrder(msg.d);
        break;
      case "pf":
        setPortfolio(msg.d.account, msg.d.positions);
        break;
      case "guard":
        toast(`🛡 ${msg.d.message}`, msg.d.action === "sell" ? "ok" : "err");
        break;
      case "settings":
        store.set({ settings: msg.d });
        break;
      case "kill":
        void actions.refreshTrading();
        break;
      case "broker":
        void actions.bootstrap();
        break;
    }
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    store.set({ conn: "closed" });
    const delay = Math.min(10_000, 500 * 2 ** attempt++);
    setTimeout(connect, delay);
  };
}

store.subscribe(() => syncSubs());
