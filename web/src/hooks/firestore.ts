import { doc, onSnapshot, type DocumentReference, type Query } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/firebase";
import type { Quote } from "../lib/types";

interface State<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

/** Subscribe to a document. Pass null to unsubscribe. `key` must change when the ref does. */
export function useDocData<T>(ref: DocumentReference | null, key: string): State<(T & { id: string }) | null> {
  const [state, setState] = useState<State<(T & { id: string }) | null>>({ data: null, loading: !!ref, error: null });
  useEffect(() => {
    if (!ref) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      ref,
      (snap) => setState({ data: snap.exists() ? ({ id: snap.id, ...snap.data() } as T & { id: string }) : null, loading: false, error: null }),
      (error) => setState({ data: null, loading: false, error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Subscribe to a query. `key` must change when the query does. */
export function useQueryData<T>(q: Query | null, key: string): State<(T & { id: string })[]> {
  const [state, setState] = useState<State<(T & { id: string })[]>>({ data: [], loading: !!q, error: null });
  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T & { id: string }), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Live quotes for a set of symbols, keyed by symbol. */
export function useQuotes(symbols: string[]): Record<string, Quote> {
  const key = useMemo(() => [...symbols].sort().join(","), [symbols]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  useEffect(() => {
    const list = key ? key.split(",") : [];
    const unsubs = list.map((s) =>
      onSnapshot(
        doc(db, "quotes", s),
        (snap) => setQuotes((prev) => ({ ...prev, [s]: snap.exists() ? (snap.data() as Quote) : { symbol: s } })),
        () => undefined,
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [key]);
  return quotes;
}
