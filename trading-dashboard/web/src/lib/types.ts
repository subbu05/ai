// Mirrors server/src/types.ts
export type AssetType = "stock" | "etf" | "option";
export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "day" | "gtc";
export type OrderStatus = "pending" | "open" | "filled" | "cancelled" | "rejected";

export interface Instrument { symbol: string; name: string; type: AssetType }

export interface Quote {
  symbol: string; last: number; bid: number; ask: number; prevClose: number;
  high: number; low: number; volume: number; ts: number;
  /** client-side: +1 / -1 / 0 vs the previous update, for flash animation */
  dir: number;
  /** Options only: IV (0.25 = 25%) and Greeks (theta per day, vega/rho per 1 point), open interest. */
  greeks?: OptionGreeks;
  oi?: number;
  underlyingPrice?: number;
}

export interface OptionGreeks { iv: number; delta: number; gamma: number; theta: number; vega: number; rho: number }

export interface Expiration { date: string; dte: number; kind: "weekly" | "monthly" }

export interface OptionChain {
  underlying: string; expiry: string; dte: number; expirations: Expiration[];
  strikes: number[]; calls: string[]; puts: string[]; multiplier: number; riskFreeRate: number;
  quotes: Omit<Quote, "dir">[];
}

export interface OptionsWidgetConfig {
  underlying: string; expiry?: string; strikes: number; view: "both" | "calls" | "puts"; greeks: boolean;
}

export interface OrderRequest {
  symbol: string; side: Side; qty: number; type: OrderType;
  limitPrice?: number; stopPrice?: number; tif?: TimeInForce;
}

export interface Order {
  id: string; symbol: string; side: Side; qty: number; type: OrderType;
  limitPrice?: number; stopPrice?: number; tif: TimeInForce; status: OrderStatus;
  filledQty: number; avgFillPrice?: number; triggered?: boolean; reason?: string;
  createdAt: number; updatedAt: number; broker: string; source?: "manual" | "profit-guard" | "kill-switch" | "expiry";
}

export interface Fill { id: string; orderId: string; symbol: string; side: Side; qty: number; price: number; ts: number; realizedPnl: number }
export interface Position { symbol: string; qty: number; avgCost: number; realizedPnl: number; openedAt: number }
export interface Account { broker: string; cash: number; buyingPower: number; startingCash: number; realizedPnl: number }

export interface Widget {
  id: string; title: string; symbols: string[];
  sort?: "manual" | "symbol" | "change" | "price"; collapsed?: boolean;
  kind?: "quotes" | "options"; options?: OptionsWidgetConfig;
}

export interface BrokerRef { id: string; name: string; live: boolean }

export interface CredentialField { key: string; label: string; secret: boolean; required: boolean; help?: string }
export interface BrokerInfo { id: string; name: string; live: boolean; implemented: boolean; fields: CredentialField[] }

export interface PublicSettings {
  broker: string; liveTradingEnabled: boolean;
  marketData: { provider: string; tickMs: number; flushMs: number };
  paper: { startingCash: number };
  profitGuard: { enabled: boolean; dropPct: number; floorPct: number; disabledSymbols: string[] };
}

export interface ExitResult { symbol: string; qty: number; status: "filled" | "open" | "rejected" | "error"; price?: number; pnl?: number; message?: string }
export interface KillSwitchReport { ts: number; scope: "all" | string[]; cancelledOrders: number; results: ExitResult[]; realizedPnl: number }

export interface GuardStatus { symbol: string; avgCost: number; peak: number; armed: boolean; triggerPrice: number | null; triggered: boolean; enabled: boolean }
export interface GuardEvent { ts: number; symbol: string; action: "sell" | "skipped" | "error"; qty?: number; price?: number; peak?: number; triggerPrice?: number; message: string }

export interface SymbolPnl {
  symbol: string; realizedPnl: number; boughtQty: number; soldQty: number;
  buyValue: number; sellValue: number; trades: number; wins: number; losses: number; lastTradeAt: number;
}
