import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Local-filesystem persistence.
 *
 * - JsonFile: a whole-document JSON file. Writes are coalesced (debounced) and atomic
 *   (write to a temp file, then rename), so a crash never leaves a half-written file and
 *   hot paths (e.g. many order updates per second) cost one disk write per window.
 * - JsonlLog: an append-only log (one JSON object per line) for fills, the audit trail.
 */
export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  private value: T;

  constructor(private path: string, fallback: T, private debounceMs = 150) {
    mkdirSync(dirname(path), { recursive: true });
    this.value = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.schedule();
  }

  /** Call after mutating the object returned by get() in place. */
  touch(): void {
    this.schedule();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    renameSync(tmp, this.path);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }
}

export class JsonlLog<T> {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: T): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  readAll(): T[] {
    if (!existsSync(this.path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as T);
    }
    return out;
  }
}

/** Registry so every open JsonFile is flushed on shutdown. */
export class Storage {
  private files: JsonFile<unknown>[] = [];
  constructor(public readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  json<T>(name: string, fallback: T): JsonFile<T> {
    const f = new JsonFile<T>(join(this.dir, name), fallback);
    this.files.push(f as JsonFile<unknown>);
    return f;
  }
  log<T>(name: string): JsonlLog<T> {
    return new JsonlLog<T>(join(this.dir, name));
  }
  flushAll(): void {
    for (const f of this.files) f.flush();
  }
}
