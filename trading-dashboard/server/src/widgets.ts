import type { Widget } from "./types.js";
import type { JsonFile, Storage } from "./storage.js";
import { HttpError, newId, normalizeSymbol } from "./util.js";

const DEFAULT_WIDGETS: Omit<Widget, "id">[] = [
  { title: "Big Tech", symbols: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META"], sort: "manual" },
  { title: "Index ETFs", symbols: ["SPY", "QQQ", "VTI", "IWM", "DIA"], sort: "manual" },
  { title: "Bonds & Metals", symbols: ["AGG", "TLT", "GLD", "SLV"], sort: "manual" },
];

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
    for (const w of this.file.get()) for (const s of w.symbols) out.add(s);
    return out;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  create(input: { title?: unknown; symbols?: unknown }): Widget {
    const w: Widget = {
      id: newId("w"),
      title: cleanTitle(input.title) ?? "New widget",
      symbols: cleanSymbols(input.symbols ?? []),
      sort: "manual",
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
