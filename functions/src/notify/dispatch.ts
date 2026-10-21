import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { APP_URL } from "../config";
import { db } from "../lib/firebase";
import { UserDoc } from "../lib/models";
import { emailConfigured, sendEmail } from "./email";
import { AlertItem, formatAlerts } from "./format";
import { sendTelegram, TelegramError } from "./telegram";

export interface DispatchResult {
  email: "sent" | "skipped" | "failed";
  telegram: "sent" | "skipped" | "failed";
}

/** Send one combined message for `alerts` to every channel the user enabled. */
export async function notifyUser(uid: string, user: UserDoc, alerts: AlertItem[]): Promise<DispatchResult> {
  const msg = formatAlerts(alerts, APP_URL.value());
  const result: DispatchResult = { email: "skipped", telegram: "skipped" };

  const emailTo = user.alertEmail || user.email;
  const tasks: Promise<void>[] = [];

  if (user.notifyEmail !== false && emailTo && emailConfigured()) {
    tasks.push(
      sendEmail(emailTo, msg.subject, msg.text, msg.html).then(
        () => void (result.email = "sent"),
        (err) => {
          result.email = "failed";
          logger.error("email send failed", { uid, err: String(err) });
        },
      ),
    );
  }

  if (user.notifyTelegram !== false && user.telegramChatId) {
    tasks.push(
      sendTelegram(user.telegramChatId, msg.telegram).then(
        () => void (result.telegram = "sent"),
        async (err) => {
          result.telegram = "failed";
          logger.error("telegram send failed", { uid, err: String(err) });
          // 403: the user blocked the bot or deleted the chat. Unlink it.
          if (err instanceof TelegramError && err.code === 403) {
            await db.doc(`users/${uid}`).update({
              telegramChatId: FieldValue.delete(),
              telegramUsername: FieldValue.delete(),
              telegramLinkedAt: FieldValue.delete(),
            });
          }
        },
      ),
    );
  }

  await Promise.all(tasks);
  return result;
}
