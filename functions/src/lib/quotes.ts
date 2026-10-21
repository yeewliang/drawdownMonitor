import { Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { getProvider, SymbolNotFoundError } from "../providers";
import { AthPoint, AthState, drawdownPct, mergeAth } from "./drawdown";
import { db } from "./firebase";
import { QuoteDoc } from "./models";

/** Re-download full daily history this often (picks up split adjustments). */
const FULL_HISTORY_MAX_AGE_MS = 20 * 60 * 60 * 1000;

export const quoteRef = (symbol: string) => db.collection("quotes").doc(symbol);

/**
 * Fetch the latest price for `symbol`, update its ATH and drawdown, and store
 * the result in quotes/{symbol}. Returns the stored document.
 */
export async function refreshQuote(symbol: string, opts: { forceFull?: boolean } = {}): Promise<QuoteDoc | null> {
  const ref = quoteRef(symbol);
  const snap = await ref.get();
  const prev = snap.exists ? (snap.data() as QuoteDoc) : null;

  const historyAge = prev?.historyRefreshedAt ? Date.now() - prev.historyRefreshedAt.toMillis() : Infinity;
  const hasAth = prev?.athIntraday != null;
  const fullHistory = !!opts.forceFull || !hasAth || historyAge > FULL_HISTORY_MAX_AGE_MS;

  const provider = getProvider();
  let q;
  try {
    q = await provider.getQuote(symbol, { fullHistory });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("quote fetch failed", { symbol, message });
    // Keep the last good data; just record the error.
    if (err instanceof SymbolNotFoundError || prev) {
      await ref.set({ symbol, error: message, updatedAt: Timestamp.now() }, { merge: true });
    }
    return null;
  }

  const ath: AthState = fullHistory ? q.ath : mergeAth(storedAth(prev), q.ath);
  const now = Timestamp.now();

  const doc: QuoteDoc = {
    symbol,
    name: q.name,
    currency: q.currency,
    exchange: q.exchange,
    instrumentType: q.instrumentType,
    timezone: q.timezone,
    price: q.price,
    previousClose: q.previousClose,
    changePct: q.previousClose ? round(((q.price - q.previousClose) / q.previousClose) * 100, 4) : null,
    marketTime: Timestamp.fromMillis(q.marketTime * 1000),
    sessionOpen: q.sessionOpen,
    athIntraday: ath.intraday?.value ?? null,
    athIntradayDate: toTs(ath.intraday),
    athClose: ath.close?.value ?? null,
    athCloseDate: toTs(ath.close),
    drawdownIntradayPct: drawdownPct(q.price, ath.intraday),
    drawdownClosePct: drawdownPct(q.price, ath.close),
    provider: provider.name,
    historyRefreshedAt: fullHistory ? now : prev?.historyRefreshedAt ?? now,
    updatedAt: now,
    error: null,
  };
  await ref.set(doc);
  return doc;
}

/** Drawdown for the user's chosen ATH basis. */
export function drawdownFor(q: QuoteDoc, basis: "close" | "intraday"): number | null {
  return basis === "intraday" ? q.drawdownIntradayPct : q.drawdownClosePct;
}

function storedAth(prev: QuoteDoc | null): AthState {
  return {
    intraday: point(prev?.athIntraday, prev?.athIntradayDate),
    close: point(prev?.athClose, prev?.athCloseDate),
  };
}

function point(value: number | null | undefined, ts: Timestamp | null | undefined): AthPoint | null {
  return value == null ? null : { value, time: ts ? ts.seconds : 0 };
}

function toTs(p: AthPoint | null): Timestamp | null {
  return p ? Timestamp.fromMillis(p.time * 1000) : null;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
