// Shared domain types. The web client mirrors these in web/src/lib/types.ts.

export type AssetType = "stock" | "etf";
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
  source?: "manual" | "profit-guard" | "kill-switch";
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
  symbols: string[];
  sort?: "manual" | "symbol" | "change" | "price";
  collapsed?: boolean;
}
