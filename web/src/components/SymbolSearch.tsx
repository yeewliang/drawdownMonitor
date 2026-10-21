import { useEffect, useRef, useState, type FormEvent } from "react";
import { searchSymbols } from "../lib/api";
import { normalizeSymbol } from "../lib/format";
import type { SymbolMatch } from "../lib/types";

interface Props {
  existing: Set<string>;
  onAdd: (symbol: string) => Promise<void>;
}

export default function SymbolSearch({ existing, onAdd }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SymbolMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    const t = setTimeout(() => {
      searchSymbols(term)
        .then((r) => id === seq.current && setResults(r))
        .catch(() => id === seq.current && setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function add(raw: string) {
    const symbol = normalizeSymbol(raw);
    if (!symbol) {
      setError("Enter a valid symbol, e.g. AAPL, ^GSPC, BTC-USD.");
      return;
    }
    if (existing.has(symbol)) {
      setError(`${symbol} is already in this watchlist.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd(symbol);
      setQ("");
      setResults([]);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add symbol.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    add(results[0] && results[0].symbol.toUpperCase() === q.trim().toUpperCase() ? results[0].symbol : q);
  }

  return (
    <div className="search">
      <form className="row" onSubmit={onSubmit}>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setError(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Add a ticker or index: AAPL, S&P 500, ^N225, Nikkei…"
          aria-label="Search symbols"
        />
        <button className="btn primary" disabled={busy || !q.trim()}>Add</button>
      </form>
      {open && results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((r) => (
            <li key={r.symbol}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(r.symbol)} disabled={existing.has(r.symbol)}>
                <b>{r.symbol}</b> <span>{r.name}</span>
                <small className="muted">{r.type} · {r.exchange}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}
