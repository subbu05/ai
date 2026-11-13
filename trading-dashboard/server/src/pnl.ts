import type { Fill } from "./types.js";
import { round2, round6 } from "./util.js";
import { multiplier } from "./options/occ.js";

export interface SymbolPnl {
  symbol: string;
  realizedPnl: number;
  boughtQty: number;
  soldQty: number;
  buyValue: number;
  sellValue: number;
  trades: number;
  wins: number; // sells with positive realized P&L
  losses: number;
  lastTradeAt: number;
}

/** Realized P&L per symbol, from the fill history. Unrealized P&L is computed live in the UI. */
export function realizedBySymbol(fills: Fill[]): SymbolPnl[] {
  const map = new Map<string, SymbolPnl>();
  for (const f of fills) {
    let r = map.get(f.symbol);
    if (!r) {
      r = { symbol: f.symbol, realizedPnl: 0, boughtQty: 0, soldQty: 0, buyValue: 0, sellValue: 0, trades: 0, wins: 0, losses: 0, lastTradeAt: 0 };
      map.set(f.symbol, r);
    }
    r.trades++;
    r.lastTradeAt = Math.max(r.lastTradeAt, f.ts);
    if (f.side === "buy") {
      r.boughtQty += f.qty;
      r.buyValue += f.qty * f.price * multiplier(f.symbol);
    } else {
      r.soldQty += f.qty;
      r.sellValue += f.qty * f.price * multiplier(f.symbol);
      r.realizedPnl += f.realizedPnl;
      if (f.realizedPnl > 0) r.wins++;
      else if (f.realizedPnl < 0) r.losses++;
    }
  }
  return [...map.values()]
    .map((r) => ({ ...r, realizedPnl: round2(r.realizedPnl), buyValue: round2(r.buyValue), sellValue: round2(r.sellValue), boughtQty: round6(r.boughtQty), soldQty: round6(r.soldQty) }))
    .sort((a, b) => b.lastTradeAt - a.lastTradeAt);
}
