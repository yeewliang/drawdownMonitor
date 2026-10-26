import { QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { drawdownSummary } from "../http/telegramBot";
import { db } from "../lib/firebase";
import { UserDoc } from "../lib/models";
import { DEFAULT_SUMMARY_HOUR, isSummaryTime } from "../lib/time";
import { sendTelegram } from "../notify/telegram";

/**
 * Runs every 5 minutes: send each owner of a `dailySummary` watchlist one
 * Telegram message when it is their chosen time in their own time zone.
 */
export async function sendDailySummaries(now = new Date()): Promise<void> {
  // ponytail: scans every opted-in list each run; index by summary time if this grows large.
  const lists = await db.collection("watchlists").where("dailySummary", "==", true).get();
  const byOwner = new Map<string, QueryDocumentSnapshot[]>();
  for (const wl of lists.docs) byOwner.set(wl.get("ownerId"), [...(byOwner.get(wl.get("ownerId")) ?? []), wl]);

  for (const [uid, owned] of byOwner) {
    const user = ((await db.doc(`users/${uid}`).get()).data() ?? {}) as UserDoc;
    if (!user.telegramChatId || user.notifyTelegram === false) continue;
    if (!isSummaryTime(now, user.summaryTimeZone, user.summaryHour ?? DEFAULT_SUMMARY_HOUR, user.summaryMinute ?? 0)) continue;
    try {
      await sendTelegram(user.telegramChatId, await drawdownSummary(owned, user.athBasis ?? "close", "☀️ Daily summary ·"));
    } catch (err) {
      logger.warn("daily summary failed", { uid, err: String(err) });
    }
  }
}
