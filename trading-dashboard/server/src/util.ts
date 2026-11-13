import { randomBytes } from "node:crypto";
import { isOption } from "./options/occ.js";

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/** Round to cents (prices) or to 6 dp (fractional share quantities). */
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export const normalizeSymbol = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const v = s.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(v) || isOption(v) ? v : null;
};

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
