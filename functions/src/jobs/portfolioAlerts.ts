import * as logger from "firebase-functions/logger";
import { APP_URL } from "../config";
import { evaluateAlerts, thresholdKey } from "../lib/drawdown";
import { db } from "../lib/firebase";
import { PortfolioDoc, QuoteDoc, UserDoc } from "../lib/models";
import { evaluatePortfolio, liveQuotes, portfolioSymbols } from "../lib/portfolioStore";
import { deliveryFailed, sendToUser } from "../notify/dispatch";
import { formatPortfolioAlert, PortfolioAlert } from "../notify/format";

export interface LoadedPortfolio {
  uid: string;
  ref: FirebaseFirestore.DocumentReference;
  data: PortfolioDoc;
}

/** Every saved portfolio. The refresh job prices their holdings and FX pairs. */
export async function loadPortfolios(): Promise<LoadedPortfolio[]> {
  const snap = await db.collection("portfolios").get();
  return snap.docs.map((d) => ({ uid: d.id, ref: d.ref, data: d.data() as PortfolioDoc }));
}

/**
 * Check each portfolio's drawdown from peak against its thresholds and alert
 * the owner.
 *
 * - Quotes whose refresh failed this cycle fall back to the last good cached
 *   quote, so a Yahoo outage cannot revert a holding to its old sync price and
 *   fake a loss.
 * - Settings, alert state and the live peak are re-read and written in a
 *   transaction, so a change the owner made during the refresh is respected
 *   and never overwritten. Alert state is committed before sending.
 */
export async function evaluatePortfolioAlerts(portfolios: LoadedPortfolio[], fresh: Map<string, QuoteDoc>): Promise<number> {
  const quotes = new Map(fresh);
  const missing = [...new Set(portfolios.flatMap((p) => portfolioSymbols(p.data)))].filter((s) => !quotes.has(s));
  for (let i = 0; i < missing.length; i += 300) {
    const snaps = await db.getAll(...missing.slice(i, i + 300).map((s) => db.collection("quotes").doc(s)));
    for (const s of snaps) {
      const q = s.data() as QuoteDoc | undefined;
      if (q?.price != null && q.marketTime) quotes.set(s.id, q);
    }
  }
  const live = liveQuotes(quotes);

  let sent = 0;
  for (const p of portfolios) {
    if (p.data.alertsEnabled === false || !(p.data.thresholds?.length)) continue;
    let alert: (PortfolioAlert & { key: string }) | null = null;
    try {
      alert = await db.runTransaction(async (tx) => {
        const snap = await tx.get(p.ref);
        const d = snap.data() as PortfolioDoc | undefined;
        if (!d || d.alertsEnabled === false || !(d.thresholds?.length) || !d.history?.dates?.length) return null;
        const { valuation, drawdown } = evaluatePortfolio(d, live);
        if (!drawdown) return null;

        const user = (await tx.get(db.doc(`users/${p.uid}`))).data() as UserDoc | undefined;
        const ev = evaluateAlerts(d.thresholds, drawdown.drawdownPct, d.alertState, user?.rearmGapPct);
        const patch: Record<string, unknown> = {};
        if (ev.changed) patch.alertState = ev.state;
        // Remember a new live high so a later fall from it is measured.
        if (drawdown.drawdownPct === 0 && drawdown.currentIndex > (d.livePeak?.index ?? -Infinity) && drawdown.currentIndex > Math.max(...d.history.index)) {
          patch.livePeak = { index: drawdown.currentIndex, at: new Date().toISOString() };
        }
        if (Object.keys(patch).length) tx.update(p.ref, patch);
        if (ev.fired == null || !user) return null;
        return {
          broker: d.broker,
          threshold: ev.fired,
          drawdownPct: drawdown.drawdownPct,
          peakDate: drawdown.peakDate,
          value: valuation.value,
          currency: d.baseCurrency,
          key: thresholdKey(ev.fired),
        };
      });
    } catch (err) {
      logger.error("portfolio evaluation failed", { uid: p.uid, err: String(err) });
      continue;
    }
    if (!alert) continue;

    let failed = true;
    try {
      const user = (await db.doc(`users/${p.uid}`).get()).data() as UserDoc;
      failed = deliveryFailed(await sendToUser(p.uid, user, formatPortfolioAlert(alert, APP_URL.value())));
    } catch (err) {
      logger.error("portfolio alert failed", { uid: p.uid, err: String(err) });
    }
    if (failed) {
      // Nothing was delivered: un-fire the threshold so the next cycle retries.
      await p.ref.update({ [`alertState.${alert.key}`]: false }).catch((err) => logger.error("portfolio alert rollback failed", { uid: p.uid, err: String(err) }));
      continue;
    }
    sent++;
  }
  return sent;
}
