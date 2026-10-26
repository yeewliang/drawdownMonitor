import { timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { onDocumentCreated, onDocumentDeleted } from "firebase-functions/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import { setGlobalOptions } from "firebase-functions/options";
import { onSchedule } from "firebase-functions/scheduler";
import { NOTIFY_SECRETS, REGION, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET } from "./config";
import { handleTelegramUpdate } from "./http/telegramBot";
import { sendDailySummaries } from "./jobs/dailySummary";
import { refreshAllAndAlert } from "./jobs/refreshAll";
import { db } from "./lib/firebase";
import { UserDoc } from "./lib/models";
import { quoteRef, refreshQuote } from "./lib/quotes";
import { normalizeSymbol } from "./lib/symbols";
import { getProvider } from "./providers";
import { createApiKey as createKey, listApiKeys as listKeys, revokeApiKey as revokeKey } from "./mcp/apiKeys";
import { handleMcpRequest } from "./mcp/http";
import { notifyUser } from "./notify/dispatch";

setGlobalOptions({ region: REGION, maxInstances: 10 });

/**
 * Refresh every tracked symbol and fire alerts. Runs every 5 minutes, so
 * prices are never more than ~5 minutes behind the provider.
 */
export const refreshQuotes = onSchedule(
  { schedule: "every 5 minutes", timeoutSeconds: 300, memory: "512MiB", secrets: NOTIFY_SECRETS },
  async () => {
    await refreshAllAndAlert();
  },
);

/** Daily Telegram summary, sent at each user's chosen hour (checked hourly). */
export const dailySummary = onSchedule(
  { schedule: "0 * * * *", secrets: [TELEGRAM_BOT_TOKEN] },
  async () => {
    await sendDailySummaries();
  },
);

/** Backfill history and price as soon as a symbol is added to a watchlist. */
export const onItemCreated = onDocumentCreated("watchlists/{wid}/items/{symbol}", async (event) => {
  const symbol = normalizeSymbol(event.params.symbol);
  if (!symbol) return;
  const existing = await quoteRef(symbol).get();
  const updatedAt = existing.get("updatedAt")?.toMillis?.() ?? 0;
  if (existing.exists && existing.get("error") == null && Date.now() - updatedAt < 5 * 60 * 1000) return;
  await refreshQuote(symbol, { forceFull: !existing.exists });
});

/** Firestore does not delete subcollections automatically. */
export const onWatchlistDeleted = onDocumentDeleted("watchlists/{wid}", async (event) => {
  await db.recursiveDelete(db.collection(`watchlists/${event.params.wid}/items`));
});

/** Symbol search for the "add symbol" box (Yahoo blocks browser CORS). */
export const searchSymbols = onCall({ memory: "256MiB" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const q = typeof req.data?.query === "string" ? req.data.query.trim().slice(0, 50) : "";
  if (!q) return { results: [] };
  try {
    return { results: await getProvider().search(q) };
  } catch (err) {
    logger.warn("search failed", { q, err: String(err) });
    throw new HttpsError("unavailable", "Symbol search is temporarily unavailable.");
  }
});

/** Send a sample alert to the caller's enabled channels. */
export const sendTestAlert = onCall({ secrets: NOTIFY_SECRETS }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const snap = await db.doc(`users/${req.auth.uid}`).get();
  const user = (snap.data() ?? {}) as UserDoc;
  user.email ??= req.auth.token.email ?? null;

  const sample = (await quoteRef("^GSPC").get()).data();
  const result = await notifyUser(req.auth.uid, user, [
    {
      symbol: "TEST",
      name: "Test alert" + (sample ? ` (S&P 500 at ${sample.price})` : ""),
      watchlistId: "",
      watchlistName: "Test",
      threshold: 10,
      drawdownPct: 10.5,
      price: 89.5,
      currency: "USD",
      ath: 100,
      athDate: new Date(),
      basis: user.athBasis ?? "close",
    },
  ]);
  return result;
});

/**
 * Telegram bot webhook. Register it once with:
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *     -d url=<function url> -d secret_token=<TELEGRAM_WEBHOOK_SECRET>
 */
export const telegramWebhook = onRequest(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET], memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }
    const got = Buffer.from(String(req.header("X-Telegram-Bot-Api-Secret-Token") ?? ""));
    const want = Buffer.from(TELEGRAM_WEBHOOK_SECRET.value());
    if (want.length === 0 || got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).send("Unauthorized");
      return;
    }
    try {
      await handleTelegramUpdate(req.body);
    } catch (err) {
      // Always 200 so Telegram does not retry the same update forever.
      logger.error("telegram update failed", { err: String(err) });
    }
    res.status(200).send("ok");
  },
);

/** Unlink the caller's Telegram chat (link fields are not client-writable). */
export const unlinkTelegram = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  await db.doc(`users/${req.auth.uid}`).update({
    telegramChatId: FieldValue.delete(),
    telegramUsername: FieldValue.delete(),
    telegramLinkedAt: FieldValue.delete(),
    telegramLinkCode: FieldValue.delete(),
  });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

/**
 * Remote MCP endpoint (Streamable HTTP). Authenticate with
 * `Authorization: Bearer <API key>` from Settings > MCP access.
 */
export const mcp = onRequest({ memory: "512MiB", timeoutSeconds: 60, cors: false }, handleMcpRequest);

export const createApiKey = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const name = typeof req.data?.name === "string" ? req.data.name : "";
  try {
    return await createKey(req.auth.uid, name);
  } catch (err) {
    throw new HttpsError("failed-precondition", err instanceof Error ? err.message : String(err));
  }
});

export const listApiKeys = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return { keys: await listKeys(req.auth.uid) };
});

export const revokeApiKey = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const id = typeof req.data?.id === "string" ? req.data.id : "";
  if (!(await revokeKey(req.auth.uid, id))) throw new HttpsError("not-found", "Key not found.");
  return { ok: true };
});
