/**
 * Black-Scholes(-Merton) pricing and Greeks for European options.
 * Inputs: S spot, K strike, T years to expiry, r risk-free rate, q dividend yield, sigma volatility.
 * Greeks use trader conventions: theta per calendar day, vega and rho per 1 percentage point.
 */
export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number; // $ per share per day
  vega: number; // $ per share per 1 vol point
  rho: number; // $ per share per 1% rate
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export function blackScholes(right: "C" | "P", S: number, K: number, T: number, r: number, q: number, sigma: number): Greeks {
  if (T <= 0 || sigma <= 0) {
    // At/after expiry: intrinsic value only.
    const itm = right === "C" ? S > K : S < K;
    return { price: Math.max(0, right === "C" ? S - K : K - S), delta: itm ? (right === "C" ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const dfr = Math.exp(-r * T), dfq = Math.exp(-q * T);
  const pdf = normPdf(d1);
  const gamma = (dfq * pdf) / (S * sigma * sqrtT);
  const vega = (S * dfq * pdf * sqrtT) / 100;
  const decay = -(S * dfq * pdf * sigma) / (2 * sqrtT);
  if (right === "C") {
    const Nd1 = normCdf(d1), Nd2 = normCdf(d2);
    return {
      price: S * dfq * Nd1 - K * dfr * Nd2,
      delta: dfq * Nd1,
      gamma,
      theta: (decay - r * K * dfr * Nd2 + q * S * dfq * Nd1) / 365,
      vega,
      rho: (K * T * dfr * Nd2) / 100,
    };
  }
  const Nmd1 = normCdf(-d1), Nmd2 = normCdf(-d2);
  return {
    price: K * dfr * Nmd2 - S * dfq * Nmd1,
    delta: -dfq * Nmd1,
    gamma,
    theta: (decay + r * K * dfr * Nmd2 - q * S * dfq * Nmd1) / 365,
    vega,
    rho: -(K * T * dfr * Nmd2) / 100,
  };
}

/**
 * Implied volatility from an option price (bisection: slow-ish but never diverges).
 * Returns null if the price is outside no-arbitrage bounds. For real data providers that
 * don't supply IV/Greeks themselves.
 */
export function impliedVol(right: "C" | "P", price: number, S: number, K: number, T: number, r: number, q = 0): number | null {
  if (T <= 0 || price <= 0) return null;
  const fwdIntrinsic = right === "C" ? S * Math.exp(-q * T) - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S * Math.exp(-q * T);
  if (price < Math.max(0, fwdIntrinsic) - 1e-9) return null;
  let lo = 1e-4, hi = 5;
  if (blackScholes(right, S, K, T, r, q, hi).price < price) return null;
  for (let i = 0; i < 60 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (blackScholes(right, S, K, T, r, q, mid).price > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
