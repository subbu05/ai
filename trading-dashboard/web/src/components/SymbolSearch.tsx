import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Instrument } from "../lib/types";

const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Ticker/name autocomplete. Arrow keys + Enter, or type any ticker and press Enter. */
export function SymbolSearch({ onPick, exclude }: { onPick: (symbol: string) => void; exclude: string[] }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Instrument[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    const t = setTimeout(() => {
      api.search(q).then((r) => {
        if (my === seq.current) {
          setResults(r.filter((i) => !exclude.includes(i.symbol)));
          setHi(0);
        }
      }).catch(() => {});
    }, 120);
    return () => clearTimeout(t);
  }, [q, open, exclude]);

  const pick = (sym: string) => {
    onPick(sym);
    setQ("");
    setOpen(false);
  };

  return (
    <div className="search">
      <input
        className="search-input"
        placeholder="Add symbol (e.g. AAPL, SPY)…"
        value={q}
        onChange={(e) => { setQ(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Escape") setOpen(false);
          else if (e.key === "Enter") {
            const sel = results[hi];
            const typed = q.trim();
            if (sel && (sel.symbol.startsWith(typed) || !TICKER.test(typed))) pick(sel.symbol);
            else if (TICKER.test(typed)) pick(typed);
          }
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => (
            <li key={r.symbol} className={i === hi ? "hi" : ""} onMouseDown={() => pick(r.symbol)} onMouseEnter={() => setHi(i)}>
              <b>{r.symbol}</b>
              <span className="muted">{r.name}</span>
              <span className={`type ${r.type}`}>{r.type.toUpperCase()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
