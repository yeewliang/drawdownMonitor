import { DocumentReference } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { evaluateAlerts, thresholdKey } from "../lib/drawdown";
import { db } from "../lib/firebase";
import { ItemDoc, QuoteDoc, UserDoc, WatchlistDoc } from "../lib/models";
import { mapPool } from "../lib/pool";
import { drawdownFor, refreshQuote } from "../lib/quotes";
import { deliveryFailed, notifyUser } from "../notify/dispatch";
import { AlertItem } from "../notify/format";
import { portfolioSymbols } from "../lib/portfolioStore";
import { evaluatePortfolioAlerts, loadPortfolios } from "./portfolioAlerts";

const FETCH_CONCURRENCY = 6;

export interface LoadedItem {
  ref: DocumentReference;
  watchlistId: string;
  data: ItemDoc;
}

/**
 * One monitoring cycle:
 *  1. collect every symbol referenced by any watchlist item,
 *  2. refresh quotes/{symbol} for each,
 *  3. evaluate each item's thresholds and send alerts per owner,
 *  4. value each saved portfolio and send portfolio drawdown alerts.
 */
export async function refreshAllAndAlert(): Promise<{ symbols: number; refreshed: number; alertsSent: number }> {
  const itemsSnap = await db.collectionGroup("items").get();
  const items: LoadedItem[] = itemsSnap.docs
    .filter((d) => d.ref.parent.parent?.parent.id === "watchlists")
    .map((d) => ({ ref: d.ref, watchlistId: d.ref.parent.parent!.id, data: d.data() as ItemDoc }));

  const portfolios = await loadPortfolios();
  const symbols = [
    ...new Set([
      ...items.map((i) => i.data.symbol),
      ...portfolios.flatMap((p) => portfolioSymbols(p.data)),
    ].filter(Boolean)),
  ];
  const settled = await mapPool(symbols, FETCH_CONCURRENCY, (s) => refreshQuote(s));
  const quotes = new Map<string, QuoteDoc>();
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) quotes.set(symbols[i], r.value);
    else if (r.status === "rejected") logger.error("refresh failed", { symbol: symbols[i], err: String(r.reason) });
  });

  let alertsSent = await evaluateAndNotify(items, quotes);
  try {
    alertsSent += await evaluatePortfolioAlerts(portfolios, quotes);
  } catch (err) {
    logger.error("portfolio alerts failed", { err: String(err) });
  }
  logger.info("refresh cycle complete", { symbols: symbols.length, refreshed: quotes.size, alertsSent });
  return { symbols: symbols.length, refreshed: quotes.size, alertsSent };
}

export async function evaluateAndNotify(items: LoadedItem[], quotes: Map<string, QuoteDoc>): Promise<number> {
  const candidates = items.filter(
    (i) => i.data.alertsEnabled && (i.data.thresholds?.length ?? 0) > 0 && quotes.has(i.data.symbol),
  );
  if (candidates.length === 0) return 0;

  const users = await loadDocs<UserDoc>("users", candidates.map((i) => i.data.ownerId));
  const watchlists = await loadDocs<WatchlistDoc>("watchlists", candidates.map((i) => i.watchlistId));

  const byOwner = new Map<string, { alert: AlertItem; ref: DocumentReference; key: string }[]>();
  const writer = db.bulkWriter();

  for (const item of candidates) {
    const quote = quotes.get(item.data.symbol)!;
    const user = users.get(item.data.ownerId);
    const wl = watchlists.get(item.watchlistId);
    // Skip orphans (owner changed / list deleted mid-run).
    if (!user || !wl || wl.ownerId !== item.data.ownerId) continue;

    const basis = user.athBasis ?? "close";
    const dd = drawdownFor(quote, basis);
    if (dd == null) continue;

    const ev = evaluateAlerts(item.data.thresholds, dd, item.data.alertState, user.rearmGapPct);
    if (ev.changed) writer.update(item.ref, { alertState: ev.state });
    if (ev.fired == null) continue;

    const ath = basis === "intraday" ? quote.athIntraday : quote.athClose;
    const athDate = basis === "intraday" ? quote.athIntradayDate : quote.athCloseDate;
    const list = byOwner.get(item.data.ownerId) ?? [];
    const alert: AlertItem = {
      symbol: quote.symbol,
      name: quote.name,
      watchlistId: item.watchlistId,
      watchlistName: wl.name,
      threshold: ev.fired,
      drawdownPct: dd,
      price: quote.price,
      currency: quote.currency,
      ath: ath ?? quote.price,
      athDate: athDate?.toDate() ?? null,
      basis,
    };
    list.push({ alert, ref: item.ref, key: thresholdKey(ev.fired) });
    byOwner.set(item.data.ownerId, list);
  }

  // Persist alert state before sending so a crash cannot cause duplicate alerts.
  await writer.close();

  let sent = 0;
  await mapPool([...byOwner.entries()], 4, async ([uid, entries]) => {
    let failed = true;
    try {
      failed = deliveryFailed(await notifyUser(uid, users.get(uid)!, entries.map((e) => e.alert)));
    } catch (err) {
      logger.error("notify failed", { uid, err: String(err) });
    }
    if (failed) {
      // Nothing was delivered: un-fire these thresholds so the next cycle retries.
      await rollbackFired(entries);
      return;
    }
    sent += entries.length;
  });
  return sent;
}

/** Set each fired threshold back to not-fired, leaving the rest of alertState alone. */
async function rollbackFired(entries: { ref: DocumentReference; key: string }[]): Promise<void> {
  const writer = db.bulkWriter();
  for (const e of entries) writer.update(e.ref, { [`alertState.${e.key}`]: false });
  await writer.close().catch((err) => logger.error("alert rollback failed", { err: String(err) }));
}

async function loadDocs<T>(collection: string, ids: string[]): Promise<Map<string, T>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, T>();
  for (let i = 0; i < unique.length; i += 300) {
    const refs = unique.slice(i, i + 300).map((id) => db.collection(collection).doc(id));
    const snaps = await db.getAll(...refs);
    for (const s of snaps) if (s.exists) out.set(s.id, s.data() as T);
  }
  return out;
}
