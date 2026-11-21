import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { PortfolioDoc, QuoteDoc } from "./models";
import {
  historyFromPeriods,
  IbkrPositionInput,
  IbkrSummaryInput,
  LiveQuote,
  mergeHistory,
  normalizePositions,
  normalizeSummary,
  PerformancePeriodInput,
  portfolioDrawdown,
  valuePortfolio,
} from "./portfolio";
import { normalizeSymbol } from "./symbols";

export const portfolioRef = (uid: string) => db.collection("portfolios").doc(uid);

/** A snapshot that cannot be stored; the message is safe to show the caller. */
export class SnapshotError extends Error {}

export interface SnapshotInput {
  broker?: string;
  summary: IbkrSummaryInput;
  positions: IbkrPositionInput[];
  performancePeriods: Record<string, PerformancePeriodInput>;
  /** Units of base currency per unit of each non-base position currency. */
  fxToBase?: Record<string, number>;
}

/**
 * Store a snapshot in a transaction, so concurrent alert changes (from the
 * user or the refresh job) are never lost. Alert settings are kept and the
 * return history is extended; everything else is replaced.
 *
 * A current performance series is required: the live drawdown compares value
 * against this snapshot, so the history must run up to it.
 */
export async function saveSnapshot(uid: string, input: SnapshotInput): Promise<{ doc: PortfolioDoc; rejected: string[] }> {
  const base = (input.summary.currency ?? "USD").toUpperCase();
  const incoming = historyFromPeriods(input.performancePeriods);
  if (!incoming.dates.length) throw new SnapshotError("performance_periods has no usable dates; pass the periods from get_pa_performance_all_periods.");

  const fxMissing = new Set<string>();
  const { positions, rejected } = normalizePositions(input.positions, normalizeSymbol, (cur) => {
    if (cur === base) return 1;
    const r = input.fxToBase?.[cur];
    if (!(typeof r === "number" && r > 0)) fxMissing.add(cur);
    return r ?? 1;
  });
  if (fxMissing.size) throw new SnapshotError(`No exchange rate to ${base} for ${[...fxMissing].join(", ")}.`);

  const ref = portfolioRef(uid);
  const doc = await db.runTransaction(async (tx) => {
    const prev = (await tx.get(ref)).data() as PortfolioDoc | undefined;
    const merged = mergeHistory(prev?.history, incoming);
    if (!merged) {
      throw new SnapshotError(
        `The performance series ends ${incoming.dates[incoming.dates.length - 1]}, before the stored history (${prev?.history.dates.at(-1)}). Fetch current performance and try again.`,
      );
    }
    const next: PortfolioDoc = {
      ownerId: uid,
      broker: input.broker ?? "IBKR",
      baseCurrency: base,
      syncedAt: Timestamp.now(),
      summary: normalizeSummary(input.summary),
      positions,
      history: merged.history,
      // A new scale makes the old live peak meaningless; the history now covers up to this snapshot anyway.
      livePeak: null,
      thresholds: prev?.thresholds ?? [10, 20, 30],
      alertsEnabled: prev?.alertsEnabled ?? true,
      alertState: prev?.alertState ?? {},
    };
    // Keep a live peak that is still above everything in the new history.
    if (merged.mode === "chained" && prev?.livePeak && prev.livePeak.index > Math.max(...merged.history.index)) {
      next.livePeak = prev.livePeak;
    }
    tx.set(ref, next);
    return next;
  });
  return { doc, rejected };
}

export function liveQuotes(quotes: Map<string, QuoteDoc> | Record<string, QuoteDoc | undefined>): Record<string, LiveQuote> {
  const entries = quotes instanceof Map ? [...quotes.entries()] : Object.entries(quotes);
  const out: Record<string, LiveQuote> = {};
  for (const [s, q] of entries) {
    if (!q || q.price == null) continue;
    out[s] = { price: q.price, previousClose: q.previousClose, currency: q.currency, marketTimeMs: q.marketTime?.toMillis() ?? 0 };
  }
  return out;
}

/** Live value and drawdown for a stored portfolio. */
export function evaluatePortfolio(p: PortfolioDoc, quotes: Record<string, LiveQuote>) {
  const valuation = valuePortfolio(p.positions, p.summary.cash, p.baseCurrency, p.syncedAt.toMillis(), quotes);
  const drawdown = portfolioDrawdown(p.history, valuation.value, valuation.snapshotValue, p.livePeak);
  return { valuation, drawdown };
}

/** Symbols to price for a portfolio: holdings plus FX pairs for non-base currencies. */
export function portfolioSymbols(p: PortfolioDoc): string[] {
  const out = new Set<string>();
  for (const x of p.positions ?? []) {
    out.add(x.symbol);
    if (x.currency !== p.baseCurrency) out.add(`${x.currency}${p.baseCurrency}=X`);
  }
  return [...out];
}
