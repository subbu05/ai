import type { Account, Fill, Order, OrderRequest, Position } from "../types.js";

export interface BrokerEvents {
  order: (order: Order) => void;
  /** Cash / positions changed (after a fill, reset, sync...). */
  portfolio: () => void;
}

/**
 * Everything the app needs from a broker. Implement this to connect Robinhood, Webull,
 * Alpaca, IBKR, Schwab, Tradier... and register it in brokers/index.ts.
 * See docs/BROKERS.md.
 */
export interface Broker {
  readonly id: string;
  readonly displayName: string;
  /** true when orders move real money. */
  readonly live: boolean;

  init(): Promise<void>;
  dispose(): Promise<void>;

  account(): Promise<Account>;
  positions(): Promise<Position[]>;
  orders(): Promise<Order[]>;
  fills(limit?: number): Promise<Fill[]>;

  placeOrder(req: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<Order>;

  /** Symbols the broker needs live quotes for (held positions + working orders). */
  watchedSymbols(): string[];

  on<E extends keyof BrokerEvents>(event: E, fn: BrokerEvents[E]): () => void;
}

/** Minimal typed event emitter for brokers. */
export class Emitter {
  private handlers: { [E in keyof BrokerEvents]: Set<BrokerEvents[E]> } = {
    order: new Set(),
    portfolio: new Set(),
  };
  on<E extends keyof BrokerEvents>(event: E, fn: BrokerEvents[E]): () => void {
    this.handlers[event].add(fn);
    return () => this.handlers[event].delete(fn);
  }
  protected emit<E extends keyof BrokerEvents>(event: E, ...args: Parameters<BrokerEvents[E]>): void {
    for (const fn of this.handlers[event]) (fn as (...a: unknown[]) => void)(...args);
  }
}
