import type { OptionChain, Expiration, KillSwitchReport, GuardEvent, GuardStatus, Account, BrokerInfo, Fill, Instrument, Order, OrderRequest, Position, PublicSettings, Quote, SymbolPnl, Widget, BrokerRef, TaxReport, TaxProfile, Dividend } from "./types";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  // Rejected orders come back as 422 with the order in the body; let the caller show the reason.
  if (!res.ok && !(res.status === 422 && data?.status === "rejected")) {
    throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export interface Bootstrap {
  broker: BrokerRef; provider: string; settings: PublicSettings; widgets: Widget[];
  account: Account; positions: Position[]; orders: Order[]; instruments: Record<string, Instrument>;
}

export const api = {
  bootstrap: () => req<Bootstrap>("GET", "/api/bootstrap"),

  createWidget: (title: string, symbols: string[] = []) => req<Widget>("POST", "/api/widgets", { title, symbols }),
  createOptionsWidget: (underlying: string) => req<Widget>("POST", "/api/widgets", { kind: "options", options: { underlying } }),
  optionChain: (underlying: string, expiry: string | undefined, strikes: number) =>
    req<OptionChain>("GET", `/api/options/${encodeURIComponent(underlying)}/chain?strikes=${strikes}${expiry ? `&expiry=${expiry}` : ""}`),
  expirations: (underlying: string) => req<{ underlying: string; expirations: Expiration[] }>("GET", `/api/options/${encodeURIComponent(underlying)}/expirations`),
  updateWidget: (id: string, patch: Partial<Widget>) => req<Widget>("PATCH", `/api/widgets/${id}`, patch),
  deleteWidget: (id: string) => req<void>("DELETE", `/api/widgets/${id}`),
  reorderWidgets: (ids: string[]) => req<Widget[]>("PUT", "/api/widgets/order", { ids }),

  search: (q: string) => req<Instrument[]>("GET", `/api/instruments/search?q=${encodeURIComponent(q)}`),
  instruments: (symbols: string[]) => req<Record<string, Instrument>>("GET", `/api/instruments?symbols=${symbols.join(",")}`),
  quotes: (symbols: string[]) => req<Omit<Quote, "dir">[]>("GET", `/api/quotes?symbols=${symbols.join(",")}`),

  account: () => req<Account>("GET", "/api/account"),
  positions: () => req<Position[]>("GET", "/api/positions"),
  orders: () => req<Order[]>("GET", "/api/orders"),
  fills: (limit = 500) => req<Fill[]>("GET", `/api/fills?limit=${limit}`),
  pnl: () => req<{ realizedPnl: number; bySymbol: SymbolPnl[] }>("GET", "/api/pnl"),
  placeOrder: (o: OrderRequest) => req<Order>("POST", "/api/orders", o),
  killSwitch: (symbols?: string[]) => req<KillSwitchReport>("POST", "/api/kill-switch", { symbols }),
  cancelOrder: (id: string) => req<Order>("DELETE", `/api/orders/${id}`),
  resetPaper: (startingCash?: number) => req<Account>("POST", "/api/paper/reset", { startingCash }),

  settings: () => req<{ settings: PublicSettings; brokers: BrokerInfo[]; credentials: Record<string, string[]>; active: string }>("GET", "/api/settings"),
  setKillSwitchFor: (symbol: string, enabled: boolean) => req<PublicSettings["profitGuard"]>("PUT", `/api/profit-guard/symbols/${encodeURIComponent(symbol)}`, { enabled }),
  profitGuard: () => req<{ settings: PublicSettings["profitGuard"]; positions: GuardStatus[]; events: GuardEvent[] }>("GET", "/api/profit-guard"),
  updateSettings: (patch: { broker?: string; liveTradingEnabled?: boolean; profitGuard?: Partial<PublicSettings["profitGuard"]> }) => req<{ settings: PublicSettings; active: string }>("PUT", "/api/settings", patch),
  taxReport: (year?: number) => req<TaxReport>("GET", `/api/tax/report${year ? `?year=${year}` : ""}`),
  saveTaxProfile: (patch: Partial<TaxProfile>) => req<TaxProfile>("PUT", "/api/tax/profile", patch),
  addDividend: (d: Omit<Dividend, "id">) => req<Dividend>("POST", "/api/dividends", d),
  deleteDividend: (id: string) => req<void>("DELETE", `/api/dividends/${id}`),
  saveCredentials: (broker: string, fields: Record<string, string>) => req<{ credentials: Record<string, string[]> }>("PUT", `/api/credentials/${broker}`, { fields }),
};
