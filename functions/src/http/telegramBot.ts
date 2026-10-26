import { FieldValue, QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { APP_URL } from "../config";
import type { AthBasis } from "../lib/drawdown";
import { db } from "../lib/firebase";
import { QuoteDoc, UserDoc } from "../lib/models";
import { drawdownFor } from "../lib/quotes";
import { escapeHtml, sendTelegram } from "../notify/telegram";

interface TgMessage {
  chat: { id: number; type: string };
  from?: { username?: string };
  text?: string;
}

const HELP =
  "<b>Drawdown Monitor bot</b>\n\n" +
  "/status - current drawdowns for your watchlists\n" +
  "/stop - unlink this chat from your account\n" +
  "/help - this message\n\n" +
  "To link your account, use the <i>Connect Telegram</i> button in the app settings.";

/** Handle one Telegram update. Only private chats are supported. */
export async function handleTelegramUpdate(update: any): Promise<void> {
  const msg: TgMessage | undefined = update?.message;
  if (!msg?.text || msg.chat?.type !== "private") return;
  const chatId = msg.chat.id;
  const [command, arg] = msg.text.trim().split(/\s+/, 2);

  switch (command.split("@")[0]) {
    case "/start":
      if (arg) return linkChat(chatId, arg, msg.from?.username ?? null);
      return sendTelegram(chatId, HELP);
    case "/stop":
      return unlinkChat(chatId);
    case "/status":
      return sendStatus(chatId);
    default:
      return sendTelegram(chatId, HELP);
  }
}

async function linkChat(chatId: number, code: string, username: string | null): Promise<void> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
    return sendTelegram(chatId, "That link code is not valid. Please use the Connect Telegram button in the app again.");
  }
  const snap = await db.collection("users").where("telegramLinkCode", "==", code).limit(1).get();
  if (snap.empty) {
    return sendTelegram(chatId, "That link has expired or was already used. Please generate a new one in the app settings.");
  }
  const userRef = snap.docs[0].ref;
  const user = snap.docs[0].data() as UserDoc;

  // A Telegram chat can only be linked to one account at a time.
  const others = await db.collection("users").where("telegramChatId", "==", chatId).get();
  const batch = db.batch();
  for (const d of others.docs) {
    if (d.id !== userRef.id) {
      batch.update(d.ref, {
        telegramChatId: FieldValue.delete(),
        telegramUsername: FieldValue.delete(),
        telegramLinkedAt: FieldValue.delete(),
      });
    }
  }
  batch.update(userRef, {
    telegramChatId: chatId,
    telegramUsername: username,
    telegramLinkedAt: FieldValue.serverTimestamp(),
    telegramLinkCode: FieldValue.delete(),
    notifyTelegram: true,
  });
  await batch.commit();
  logger.info("telegram linked", { uid: userRef.id });
  await sendTelegram(
    chatId,
    `✅ Linked to <b>${escapeHtml(user.email ?? user.displayName ?? "your account")}</b>.\n` +
      "You will receive drawdown alerts here. Send /status to see current drawdowns.",
  );
}

async function unlinkChat(chatId: number): Promise<void> {
  const snap = await db.collection("users").where("telegramChatId", "==", chatId).get();
  const batch = db.batch();
  snap.docs.forEach((d) =>
    batch.update(d.ref, {
      telegramChatId: FieldValue.delete(),
      telegramUsername: FieldValue.delete(),
      telegramLinkedAt: FieldValue.delete(),
    }),
  );
  await batch.commit();
  await sendTelegram(chatId, snap.empty ? "This chat is not linked to any account." : "Unlinked. You will no longer receive alerts here.");
}

async function sendStatus(chatId: number): Promise<void> {
  const users = await db.collection("users").where("telegramChatId", "==", chatId).limit(1).get();
  if (users.empty) return sendTelegram(chatId, "This chat is not linked yet. Use Connect Telegram in the app settings.");
  const uid = users.docs[0].id;
  const basis = (users.docs[0].data() as UserDoc).athBasis ?? "close";

  const lists = await db.collection("watchlists").where("ownerId", "==", uid).get();
  if (lists.empty) return sendTelegram(chatId, "You have no watchlists yet.");
  await sendTelegram(chatId, await drawdownSummary(lists.docs, basis, "📊"));
}

/** Drawdowns of every symbol in the given lists, deepest first per list. */
export async function drawdownSummary(lists: QueryDocumentSnapshot[], basis: AthBasis, icon: string): Promise<string> {
  const sections: string[] = [];
  for (const wl of lists) {
    const items = await wl.ref.collection("items").get();
    const symbols = items.docs.map((d) => d.id);
    const quotes = symbols.length ? await db.getAll(...symbols.map((s) => db.collection("quotes").doc(s))) : [];
    const rows = quotes
      .map((q) => (q.exists ? (q.data() as QuoteDoc) : null))
      .filter((q): q is QuoteDoc => !!q && q.price != null)
      .map((q) => ({ q, dd: drawdownFor(q, basis) ?? 0 }))
      .sort((a, b) => b.dd - a.dd)
      .map(({ q, dd }) => `<code>${escapeHtml(q.symbol.padEnd(10))}</code> -${dd.toFixed(2)}%`);
    sections.push(`<b>${escapeHtml(wl.get("name"))}</b>\n${rows.join("\n") || "<i>empty</i>"}`);
  }
  return `${icon} Drawdown from ${basis} ATH\n\n${sections.join("\n\n")}\n\n<a href="${APP_URL.value()}">Open app</a>`;
}
