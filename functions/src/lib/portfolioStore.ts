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

export interface SnapshotInput {
  broker?: string;
  summary: IbkrSummaryInput;
  positions: IbkrPositionInput[];
  performancePeriods?: Record<string, PerformancePeriodInput>;
}

/**
 * Store a snapshot. Alert settings and the return history beyond what the
 * snapshot covers are kept; everything else is replaced.
 */
export async function saveSnapshot(uid: string, input: SnapshotInput): Promise<{ doc: PortfolioDoc; rejected: string[] }> {
  const ref = portfolioRef(uid);
  const prev = (await ref.get()).data() as PortfolioDoc | undefined;
  const { positions, rejected } = normalizePositions(input.positions, normalizeSymbol);
  const incoming = input.performancePeriods ? historyFromPeriods(input.performancePeriods) : null;
  const history = incoming && incoming.dates.length ? mergeHistory(prev?.history, incoming) : prev?.history ?? { dates: [], index: [], nav: [] };

  const doc: PortfolioDoc = {
    ownerId: uid,
    broker: input.broker ?? "IBKR",
    baseCurrency: input.summary.currency ?? prev?.baseCurrency ?? "USD",
    syncedAt: Timestamp.now(),
    summary: normalizeSummary(input.summary),
    positions,
    history,
    thresholds: prev?.thresholds ?? [10, 20, 30],
    alertsEnabled: prev?.alertsEnabled ?? true,
    alertState: prev?.alertState ?? {},
  };
  await ref.set(doc);
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
  const valuation = valuePortfolio(p.positions, p.summary.cash, p.syncedAt.toMillis(), quotes);
  const drawdown = portfolioDrawdown(p.history, valuation.value, valuation.snapshotValue);
  return { valuation, drawdown };
}
