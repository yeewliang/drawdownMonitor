/** Yahoo-style symbols: AAPL, BRK-B, ^GSPC, EURUSD=X, BTC-USD, 7203.T */
const SYMBOL_RE = /^[A-Z0-9.^=\-]{1,32}$/;

export function normalizeSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}
