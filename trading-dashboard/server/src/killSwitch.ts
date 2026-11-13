import type { Broker } from "./brokers/broker.js";
import { multiplier } from "./options/occ.js";
import type { QuoteHub } from "./market/quoteHub.js";
import { round2 } from "./util.js";

export interface ExitResult {
  symbol: string;
  qty: number;
  status: "filled" | "open" | "rejected" | "error";
  price?: number; // fill price
  pnl?: number; // realized by this exit
  message?: string;
}

export interface KillSwitchReport {
  ts: number;
  scope: "all" | string[];
  cancelledOrders: number;
  results: ExitResult[];
  realizedPnl: number; // sum over filled exits
}

/**
 * Kill switch: get flat now, at market, and keep whatever P&L that gives.
 *
 * 1. Cancel open orders (all of them, or only for the given symbols), so nothing re-opens a
 *    position and no shares are tied up in resting sells.
 * 2. Market-sell the full quantity of every position (or the given symbols), all in parallel.
 *
 * It doesn't wait for a better price: avoiding further losses is the point. Fills are at the
 * bid, so the result can be a profit or a loss depending on where each position stands.
 */
export async function killSwitch(broker: Broker, hub: QuoteHub, symbols?: string[]): Promise<KillSwitchReport> {
  const only = symbols?.length ? new Set(symbols) : null;
  const inScope = (s: string) => !only || only.has(s);

  const open = (await broker.orders()).filter((o) => o.status === "open" && inScope(o.symbol));
  const cancelled = await Promise.allSettled(open.map((o) => broker.cancelOrder(o.id)));

  const positions = (await broker.positions()).filter((p) => p.qty > 0 && inScope(p.symbol));
  await hub.getMany(positions.map((p) => p.symbol)); // make sure every symbol has a quote

  const results = await Promise.all(
    positions.map(async (p): Promise<ExitResult> => {
      try {
        const o = await broker.placeOrder({ symbol: p.symbol, side: "sell", qty: p.qty, type: "market", source: "kill-switch" });
        const filled = o.status === "filled" && o.avgFillPrice !== undefined;
        return {
          symbol: p.symbol, qty: p.qty,
          status: o.status === "filled" ? "filled" : o.status === "rejected" ? "rejected" : "open",
          price: o.avgFillPrice,
          pnl: filled ? round2((o.avgFillPrice! - p.avgCost) * p.qty * multiplier(p.symbol)) : undefined,
          message: o.reason,
        };
      } catch (err) {
        return { symbol: p.symbol, qty: p.qty, status: "error", message: (err as Error).message };
      }
    }),
  );

  return {
    ts: Date.now(),
    scope: only ? [...only] : "all",
    cancelledOrders: cancelled.filter((c) => c.status === "fulfilled").length,
    results,
    realizedPnl: round2(results.reduce((s, r) => s + (r.pnl ?? 0), 0)),
  };
}
