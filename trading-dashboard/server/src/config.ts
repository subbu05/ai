import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the folder containing config/ and data/). Override with TD_HOME. */
export const ROOT = process.env.TD_HOME
  ? resolve(process.env.TD_HOME)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONFIG_DIR = join(ROOT, "config");
const DEFAULTS_FILE = join(CONFIG_DIR, "settings.json");
const LOCAL_FILE = join(CONFIG_DIR, "settings.local.json");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.local.json");

export type BrokerId = "paper" | "robinhood" | "webull";

export interface AppSettings {
  host: string;
  port: number;
  dataDir: string;
  broker: BrokerId;
  /** Must be true before any order is sent to a real-money broker. */
  liveTradingEnabled: boolean;
  marketData: { provider: string; tickMs: number; volatility: number; flushMs: number };
  paper: { startingCash: number };
}

const BUILTIN: AppSettings = {
  host: "127.0.0.1",
  port: 8787,
  dataDir: "data",
  broker: "paper",
  liveTradingEnabled: false,
  marketData: { provider: "simulated", tickMs: 250, volatility: 0.0006, flushMs: 100 },
  paper: { startingCash: 100_000 },
};

const readJson = (path: string): Record<string, unknown> =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};

function merge<T>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object"
      ? merge(b, v as Record<string, unknown>)
      : v;
  }
  return out as T;
}

/** settings = built-in defaults <- config/settings.json <- config/settings.local.json <- env */
export function loadSettings(): AppSettings {
  let s = merge(BUILTIN, readJson(DEFAULTS_FILE));
  s = merge(s, readJson(LOCAL_FILE));
  if (process.env.PORT) s.port = Number(process.env.PORT);
  if (process.env.HOST) s.host = process.env.HOST;
  if (process.env.TD_BROKER) s.broker = process.env.TD_BROKER as BrokerId;
  return s;
}

export function dataDir(s: AppSettings): string {
  return isAbsolute(s.dataDir) ? s.dataDir : join(ROOT, s.dataDir);
}

/** Persist user-changed settings (only the given keys) to settings.local.json. */
export function saveLocalSettings(patch: Partial<AppSettings>): void {
  const current = readJson(LOCAL_FILE);
  writeAtomic(LOCAL_FILE, JSON.stringify(merge(current, patch as Record<string, unknown>), null, 2), 0o644);
}

// ---------------------------------------------------------------------------------------
// Credentials: config/credentials.local.json, git-ignored, written with mode 0600.
// Shape: { "<broker>": { "<field>": "<value>" } }. Values never leave the server: the API
// only reports which fields are set.
// ---------------------------------------------------------------------------------------

export type Credentials = Record<string, Record<string, string>>;

export function loadCredentials(): Credentials {
  return readJson(CREDENTIALS_FILE) as Credentials;
}

export function saveCredentials(broker: string, fields: Record<string, string>): void {
  const all = loadCredentials();
  const next = { ...(all[broker] ?? {}) };
  for (const [k, v] of Object.entries(fields)) {
    if (v === "") delete next[k];
    else next[k] = v;
  }
  all[broker] = next;
  writeAtomic(CREDENTIALS_FILE, JSON.stringify(all, null, 2), 0o600);
}

/** Field names that are set (values withheld). */
export function credentialStatus(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [b, f] of Object.entries(loadCredentials())) out[b] = Object.keys(f).filter((k) => f[k]);
  return out;
}

function writeAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
