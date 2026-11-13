// Shared domain types. The web client mirrors these in web/src/lib/types.ts.

export type AssetType = "stock" | "etf" | "option";
export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "day" | "gtc";
export type OrderStatus = "pending" | "open" | "filled" | "cancelled" | "rejected";

export interface Instrument {
  symbol: string;
  name: string;
  type: AssetType;
}

export interface Quote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  prevClose: number;
  high: number;
  low: number;
  volume: number;
  ts: number; // epoch ms
  /** Options only: implied volatility (0.25 = 25%) and Greeks (theta per day, vega/rho per 1 point). */
  greeks?: OptionGreeks;
  /** Options only: open interest (contracts). */
  oi?: number;
  /** Options only: underlying price used for the Greeks. */
  underlyingPrice?: number;
}

export interface OptionGreeks {
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  tif?: TimeInForce;
  /** Who created the order: the user, or an automation such as the profit guard. */
  source?: "manual" | "profit-guard" | "kill-switch";
}

export type OrderSource = "manual" | "profit-guard" | "kill-switch" | "expiry";

export interface Order extends Required<Pick<OrderRequest, "symbol" | "side" | "qty" | "type">> {
  id: string;
  limitPrice?: number;
  stopPrice?: number;
  tif: TimeInForce;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice?: number;
  triggered?: boolean; // stop orders: stop price has been hit
  reason?: string; // rejection / cancel reason
  createdAt: number;
  updatedAt: number;
  broker: string;
  source?: OrderSource;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  ts: number;
  realizedPnl: number; // P&L realized by this fill (sells only)
}

export interface Position {
  symbol: string;
  qty: number;
  avgCost: number;
  realizedPnl: number; // lifetime realized P&L on this symbol
  openedAt: number;
}

export interface Account {
  broker: string;
  cash: number;
  buyingPower: number;
  startingCash: number;
  realizedPnl: number;
}

export interface Widget {
  id: string;
  title: string;
  /** "quotes" (default): a watchlist of stocks/ETFs. "options": an option chain for one underlying. */
  kind?: "quotes" | "options";
  symbols: string[];
  sort?: "manual" | "symbol" | "change" | "price";
  collapsed?: boolean;
  options?: OptionsWidgetConfig;
}

export interface OptionsWidgetConfig {
  underlying: string;
  /** YYYY-MM-DD; missing or expired = nearest expiration. */
  expiry?: string;
  /** Strikes shown on each side of the money. */
  strikes: number;
  view: "both" | "calls" | "puts";
  greeks: boolean;
}
