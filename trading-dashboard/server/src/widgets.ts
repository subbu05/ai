import type { OptionsWidgetConfig, Widget } from "./types.js";
import { isOption } from "./options/occ.js";
import type { JsonFile, Storage } from "./storage.js";
import { HttpError, newId, normalizeSymbol } from "./util.js";

const DEFAULT_WIDGETS: Omit<Widget, "id">[] = [
  { title: "Big Tech", symbols: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META"], sort: "manual" },
  { title: "Index ETFs", symbols: ["SPY", "QQQ", "VTI", "IWM", "DIA"], sort: "manual" },
  { title: "Bonds & Metals", symbols: ["AGG", "TLT", "GLD", "SLV"], sort: "manual" },
  { title: "AAPL options", kind: "options", symbols: [], options: { underlying: "AAPL", strikes: 8, view: "both", greeks: true } },
];

const VIEWS = new Set(["both", "calls", "puts"]);

const SORTS = new Set(["manual", "symbol", "change", "price"]);
const MAX_SYMBOLS = 200;

export class WidgetStore {
  private file: JsonFile<Widget[]>;
  private listeners = new Set<() => void>();

  constructor(storage: Storage) {
    this.file = storage.json<Widget[]>("widgets.json", DEFAULT_WIDGETS.map((w) => ({ ...w, id: newId("w") })));
  }

  list(): Widget[] {
    return this.file.get();
  }

  allSymbols(): Set<string> {
    const out = new Set<string>();
    for (const w of this.file.get()) {
      for (const s of w.symbols) out.add(s);
      if (w.options) out.add(w.options.underlying); // contracts are streamed per browser tab
    }
    return out;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  create(input: { title?: unknown; symbols?: unknown; kind?: unknown; options?: unknown }): Widget {
    if (input.kind !== undefined && input.kind !== "quotes" && input.kind !== "options") throw new HttpError(400, "kind must be quotes or options");
    const options = input.kind === "options" ? cleanOptions(input.options, { underlying: "SPY", strikes: 8, view: "both", greeks: true }) : undefined;
    const w: Widget = {
      id: newId("w"),
      title: cleanTitle(input.title) ?? (options ? `${options.underlying} options` : "New widget"),
      symbols: options ? [] : cleanSymbols(input.symbols ?? []),
      sort: "manual",
      ...(options ? { kind: "options" as const, options } : {}),
    };
    this.file.get().push(w);
    this.changed();
    return w;
  }

  update(id: string, patch: Record<string, unknown>): Widget {
    const w = this.find(id);
    if (patch.title !== undefined) w.title = cleanTitle(patch.title) ?? w.title;
    if (patch.symbols !== undefined) w.symbols = cleanSymbols(patch.symbols);
    if (patch.sort !== undefined) {
      if (typeof patch.sort !== "string" || !SORTS.has(patch.sort)) throw new HttpError(400, "Invalid sort");
      w.sort = patch.sort as Widget["sort"];
    }
    if (patch.collapsed !== undefined) w.collapsed = !!patch.collapsed;
    if (patch.options !== undefined) {
      if (w.kind !== "options" || !w.options) throw new HttpError(400, "Not an options widget");
      const prev = w.options;
      w.options = cleanOptions(patch.options, prev);
      // Keep an automatic title in step with the underlying.
      if (w.options.underlying !== prev.underlying && w.title === `${prev.underlying} options` && patch.title === undefined) {
        w.title = `${w.options.underlying} options`;
      }
    }
    this.changed();
    return w;
  }

  remove(id: string): void {
    const list = this.file.get();
    const i = list.findIndex((w) => w.id === id);
    if (i < 0) throw new HttpError(404, "Widget not found");
    list.splice(i, 1);
    this.changed();
  }

  reorder(ids: unknown): Widget[] {
    if (!Array.isArray(ids)) throw new HttpError(400, "ids must be an array");
    const list = this.file.get();
    const pos = new Map(ids.map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
    this.changed();
    return list;
  }

  private find(id: string): Widget {
    const w = this.file.get().find((x) => x.id === id);
    if (!w) throw new HttpError(404, "Widget not found");
    return w;
  }

  private changed(): void {
    this.file.touch();
    for (const fn of this.listeners) fn();
  }
}

function cleanTitle(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const v = t.trim().slice(0, 80);
  return v || null;
}

function cleanSymbols(input: unknown): string[] {
  if (!Array.isArray(input)) throw new HttpError(400, "symbols must be an array");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const s = normalizeSymbol(raw);
    if (!s) throw new HttpError(400, `Invalid symbol: ${String(raw)}`);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  if (out.length > MAX_SYMBOLS) throw new HttpError(400, `At most ${MAX_SYMBOLS} symbols per widget`);
  return out;
}

function cleanOptions(input: unknown, base: OptionsWidgetConfig): OptionsWidgetConfig {
  if (input === undefined || input === null) return { ...base };
  if (typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "options must be an object");
  const o = input as Record<string, unknown>;
  const out: OptionsWidgetConfig = { ...base };
  if (o.underlying !== undefined) {
    const u = normalizeSymbol(o.underlying);
    if (!u || isOption(u)) throw new HttpError(400, "underlying must be a stock or ETF symbol");
    if (u !== base.underlying) delete out.expiry; // expirations differ per underlying
    out.underlying = u;
  }
  if (o.expiry !== undefined) {
    if (o.expiry === null || o.expiry === "") delete out.expiry;
    else if (typeof o.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.expiry)) out.expiry = o.expiry;
    else throw new HttpError(400, "expiry must be YYYY-MM-DD");
  }
  if (o.strikes !== undefined) {
    const n = Number(o.strikes);
    if (!Number.isInteger(n) || n < 2 || n > 25) throw new HttpError(400, "strikes must be 2-25");
    out.strikes = n;
  }
  if (o.view !== undefined) {
    if (typeof o.view !== "string" || !VIEWS.has(o.view)) throw new HttpError(400, "view must be both, calls or puts");
    out.view = o.view as OptionsWidgetConfig["view"];
  }
  if (o.greeks !== undefined) out.greeks = !!o.greeks;
  return out;
}
