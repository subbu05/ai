import type { Instrument } from "../types.js";
import { describe, parseOcc } from "../options/occ.js";

/**
 * Built-in symbol catalog used for search/autocomplete and to seed the simulator.
 * Seed prices are only starting points for simulated data, not real quotes.
 * Any other valid ticker can still be added; it gets a deterministic seed price.
 */
export const CATALOG: (Instrument & { seed: number })[] = [
  // ETFs
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", type: "etf", seed: 600 },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", type: "etf", seed: 550 },
  { symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", seed: 295 },
  { symbol: "QQQ", name: "Invesco QQQ Trust", type: "etf", seed: 520 },
  { symbol: "IWM", name: "iShares Russell 2000 ETF", type: "etf", seed: 225 },
  { symbol: "DIA", name: "SPDR Dow Jones Industrial Average ETF", type: "etf", seed: 430 },
  { symbol: "AGG", name: "iShares Core U.S. Aggregate Bond ETF", type: "etf", seed: 99 },
  { symbol: "BND", name: "Vanguard Total Bond Market ETF", type: "etf", seed: 73 },
  { symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", type: "etf", seed: 90 },
  { symbol: "GLD", name: "SPDR Gold Shares", type: "etf", seed: 250 },
  { symbol: "SLV", name: "iShares Silver Trust", type: "etf", seed: 30 },
  { symbol: "XLK", name: "Technology Select Sector SPDR", type: "etf", seed: 230 },
  { symbol: "XLF", name: "Financial Select Sector SPDR", type: "etf", seed: 48 },
  { symbol: "XLE", name: "Energy Select Sector SPDR", type: "etf", seed: 90 },
  { symbol: "XLV", name: "Health Care Select Sector SPDR", type: "etf", seed: 145 },
  { symbol: "SCHD", name: "Schwab U.S. Dividend Equity ETF", type: "etf", seed: 28 },
  { symbol: "VXUS", name: "Vanguard Total International Stock ETF", type: "etf", seed: 63 },
  { symbol: "ARKK", name: "ARK Innovation ETF", type: "etf", seed: 55 },
  { symbol: "SOXX", name: "iShares Semiconductor ETF", type: "etf", seed: 230 },
  { symbol: "TQQQ", name: "ProShares UltraPro QQQ", type: "etf", seed: 75 },
  // Stocks
  { symbol: "AAPL", name: "Apple Inc.", type: "stock", seed: 225 },
  { symbol: "MSFT", name: "Microsoft Corp.", type: "stock", seed: 430 },
  { symbol: "NVDA", name: "NVIDIA Corp.", type: "stock", seed: 140 },
  { symbol: "AMZN", name: "Amazon.com Inc.", type: "stock", seed: 200 },
  { symbol: "GOOGL", name: "Alphabet Inc. Class A", type: "stock", seed: 175 },
  { symbol: "META", name: "Meta Platforms Inc.", type: "stock", seed: 580 },
  { symbol: "TSLA", name: "Tesla Inc.", type: "stock", seed: 250 },
  { symbol: "AVGO", name: "Broadcom Inc.", type: "stock", seed: 175 },
  { symbol: "AMD", name: "Advanced Micro Devices", type: "stock", seed: 150 },
  { symbol: "NFLX", name: "Netflix Inc.", type: "stock", seed: 750 },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", type: "stock", seed: 220 },
  { symbol: "V", name: "Visa Inc.", type: "stock", seed: 290 },
  { symbol: "MA", name: "Mastercard Inc.", type: "stock", seed: 510 },
  { symbol: "BRK.B", name: "Berkshire Hathaway Class B", type: "stock", seed: 460 },
  { symbol: "UNH", name: "UnitedHealth Group", type: "stock", seed: 560 },
  { symbol: "JNJ", name: "Johnson & Johnson", type: "stock", seed: 155 },
  { symbol: "WMT", name: "Walmart Inc.", type: "stock", seed: 85 },
  { symbol: "COST", name: "Costco Wholesale", type: "stock", seed: 900 },
  { symbol: "KO", name: "Coca-Cola Co.", type: "stock", seed: 68 },
  { symbol: "PEP", name: "PepsiCo Inc.", type: "stock", seed: 160 },
  { symbol: "DIS", name: "Walt Disney Co.", type: "stock", seed: 100 },
  { symbol: "INTC", name: "Intel Corp.", type: "stock", seed: 23 },
  { symbol: "ORCL", name: "Oracle Corp.", type: "stock", seed: 180 },
  { symbol: "CRM", name: "Salesforce Inc.", type: "stock", seed: 300 },
  { symbol: "ADBE", name: "Adobe Inc.", type: "stock", seed: 500 },
  { symbol: "PLTR", name: "Palantir Technologies", type: "stock", seed: 60 },
  { symbol: "UBER", name: "Uber Technologies", type: "stock", seed: 72 },
  { symbol: "COIN", name: "Coinbase Global", type: "stock", seed: 260 },
  { symbol: "HOOD", name: "Robinhood Markets", type: "stock", seed: 35 },
  { symbol: "SHOP", name: "Shopify Inc.", type: "stock", seed: 100 },
  { symbol: "XOM", name: "Exxon Mobil Corp.", type: "stock", seed: 115 },
  { symbol: "BA", name: "Boeing Co.", type: "stock", seed: 155 },
];

const bySymbol = new Map(CATALOG.map((i) => [i.symbol, i]));

export function lookup(symbol: string): Instrument {
  const hit = bySymbol.get(symbol);
  if (hit) return { symbol: hit.symbol, name: hit.name, type: hit.type };
  const opt = parseOcc(symbol);
  if (opt) return { symbol, name: describe(opt), type: "option" };
  return { symbol, name: symbol, type: "stock" };
}

export function seedPrice(symbol: string): number {
  const hit = bySymbol.get(symbol);
  if (hit) return hit.seed;
  // Deterministic pseudo-price in [10, 410) from the ticker text.
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) h = Math.imul(h ^ symbol.charCodeAt(i), 16777619);
  return 10 + ((h >>> 0) % 40000) / 100;
}

export function search(q: string, limit = 12): Instrument[] {
  const query = q.trim().toUpperCase();
  if (!query) return CATALOG.slice(0, limit).map(({ seed: _s, ...i }) => i);
  const starts: Instrument[] = [];
  const contains: Instrument[] = [];
  for (const { seed: _s, ...i } of CATALOG) {
    if (i.symbol.startsWith(query)) starts.push(i);
    else if (i.name.toUpperCase().includes(query)) contains.push(i);
  }
  return [...starts, ...contains].slice(0, limit);
}
