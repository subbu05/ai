import type { AppSettings, Credentials } from "../config.js";
import type { MarketDataProvider } from "./provider.js";
import { SimulatedProvider } from "./simulated.js";
import { AlpacaDataProvider } from "./alpaca.js";

/** Alpaca keys to use for market data: the active Alpaca account's, else whichever is saved. */
export function alpacaDataKeys(settings: AppSettings, creds: Credentials): { keyId: string; secretKey: string } | null {
  const order = settings.broker === "alpaca-live" ? ["alpaca-live", "alpaca-paper"] : ["alpaca-paper", "alpaca-live"];
  for (const id of order) {
    const c = creds[id];
    if (c?.keyId && c?.secretKey) return { keyId: c.keyId, secretKey: c.secretKey };
  }
  return null;
}

/**
 * provider "auto" (default): real Alpaca prices when Alpaca keys are saved, simulated otherwise.
 * "alpaca" requires keys; "simulated" always simulates.
 */
export function createMarketData(settings: AppSettings, creds: Credentials): MarketDataProvider {
  const md = settings.marketData;
  const simulated = () => new SimulatedProvider({ tickMs: md.tickMs, volatility: md.volatility });
  switch (md.provider) {
    case "simulated":
      return simulated();
    case "auto":
    case "alpaca": {
      const keys = alpacaDataKeys(settings, creds);
      if (keys) return new AlpacaDataProvider(keys, { feed: md.alpacaFeed });
      if (md.provider === "alpaca") console.error("Market data is set to Alpaca but no Alpaca keys are saved: using simulated prices.");
      return simulated();
    }
    default:
      throw new Error(`Unknown market data provider: ${md.provider}`);
  }
}
