import type { AppSettings } from "../config.js";
import type { MarketDataProvider } from "./provider.js";
import { SimulatedProvider } from "./simulated.js";

export function createMarketData(settings: AppSettings): MarketDataProvider {
  switch (settings.marketData.provider) {
    case "simulated":
      return new SimulatedProvider({
        tickMs: settings.marketData.tickMs,
        volatility: settings.marketData.volatility,
      });
    default:
      // Add real providers here, e.g. `case "polygon": return new PolygonProvider(creds)`.
      throw new Error(`Unknown market data provider: ${settings.marketData.provider}`);
  }
}
