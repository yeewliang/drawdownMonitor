import * as logger from "firebase-functions/logger";
import { APP_URL } from "../config";
import { evaluateAlerts } from "../lib/drawdown";
import { db } from "../lib/firebase";
import { PortfolioDoc, QuoteDoc, UserDoc } from "../lib/models";
import { evaluatePortfolio, liveQuotes } from "../lib/portfolioStore";
import { sendToUser } from "../notify/dispatch";
import { formatPortfolioAlert } from "../notify/format";

export interface LoadedPortfolio {
  uid: string;
  ref: FirebaseFirestore.DocumentReference;
  data: PortfolioDoc;
}

/** Every saved portfolio. The refresh job also prices their holdings. */
export async function loadPortfolios(): Promise<LoadedPortfolio[]> {
  const snap = await db.collection("portfolios").get();
  return snap.docs.map((d) => ({ uid: d.id, ref: d.ref, data: d.data() as PortfolioDoc }));
}

/**
 * Check each portfolio's drawdown from peak against its thresholds and alert
 * the owner. Alert state is saved before sending, as for symbol alerts.
 */
export async function evaluatePortfolioAlerts(portfolios: LoadedPortfolio[], quotes: Map<string, QuoteDoc>): Promise<number> {
  const live = liveQuotes(quotes);
  let sent = 0;
  for (const p of portfolios) {
    const d = p.data;
    if (d.alertsEnabled === false || !(d.thresholds?.length) || !d.history?.dates?.length) continue;
    const { valuation, drawdown } = evaluatePortfolio(d, live);
    if (!drawdown) continue;

    const user = (await db.doc(`users/${p.uid}`).get()).data() as UserDoc | undefined;
    if (!user) continue;
    const ev = evaluateAlerts(d.thresholds, drawdown.drawdownPct, d.alertState, user.rearmGapPct);
    if (ev.changed) await p.ref.update({ alertState: ev.state });
    if (ev.fired == null) continue;

    try {
      await sendToUser(
        p.uid,
        user,
        formatPortfolioAlert(
          {
            broker: d.broker,
            threshold: ev.fired,
            drawdownPct: drawdown.drawdownPct,
            peakDate: drawdown.peakDate,
            value: valuation.value,
            currency: d.baseCurrency,
          },
          APP_URL.value(),
        ),
      );
      sent++;
    } catch (err) {
      logger.error("portfolio alert failed", { uid: p.uid, err: String(err) });
    }
  }
  return sent;
}
