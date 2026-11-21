/**
 * Regression: when every notification channel fails, the fired threshold must
 * be rolled back so the next refresh cycle retries, for both watchlist and
 * portfolio alerts. Failures are simulated in the email and Telegram senders,
 * so the real dispatch code runs.
 */
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => {
  process.env.APP_URL ??= "https://app.example";
  return { email: true, telegram: true, emails: 0, telegrams: 0 };
});

vi.mock("../../src/notify/email", () => ({
  emailConfigured: () => true,
  sendEmail: async () => {
    send.emails++;
    if (!send.email) throw new Error("SMTP down");
  },
}));

vi.mock("../../src/notify/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notify/telegram")>()),
  sendTelegram: async () => {
    send.telegrams++;
    if (!send.telegram) throw new Error("Telegram down");
  },
}));

import { evaluatePortfolioAlerts } from "../../src/jobs/portfolioAlerts";
import { evaluateAndNotify, LoadedItem } from "../../src/jobs/refreshAll";
import { db } from "../../src/lib/firebase";
import { ItemDoc, PortfolioDoc, QuoteDoc } from "../../src/lib/models";

const quote = (symbol: string, price: number, ath: number) =>
  ({
    symbol,
    name: symbol,
    currency: "USD",
    price,
    previousClose: price,
    changePct: 0,
    marketTime: Timestamp.now(),
    athClose: ath,
    athCloseDate: Timestamp.now(),
    athIntraday: ath,
    athIntradayDate: Timestamp.now(),
    drawdownClosePct: (1 - price / ath) * 100,
    drawdownIntradayPct: (1 - price / ath) * 100,
    updatedAt: Timestamp.now(),
    error: null,
  }) as unknown as QuoteDoc;

beforeEach(async () => {
  Object.assign(send, { email: true, telegram: true, emails: 0, telegrams: 0 });
  await db.recursiveDelete(db.collection("watchlists"));
  await db.recursiveDelete(db.collection("portfolios"));
  await db.doc("users/alice").set({ email: "alice@example.com", notifyEmail: true, notifyTelegram: true, telegramChatId: 42, athBasis: "close" });
});

describe("watchlist alerts", () => {
  async function seed() {
    await db.doc("watchlists/w1").set({ ownerId: "alice", name: "Mine", isPublic: false, sharedWith: [] });
    const ref = db.doc("watchlists/w1/items/AAPL");
    await ref.set({ symbol: "AAPL", ownerId: "alice", thresholds: [10], alertsEnabled: true, alertState: {} });
    return ref;
  }
  const run = async (ref: FirebaseFirestore.DocumentReference) => {
    const items: LoadedItem[] = [{ ref, watchlistId: "w1", data: (await ref.get()).data() as ItemDoc }];
    return evaluateAndNotify(items, new Map([["AAPL", quote("AAPL", 80, 100)]]));
  };

  it("rolls back the fired threshold when every channel fails, then retries", async () => {
    const ref = await seed();
    Object.assign(send, { email: false, telegram: false });
    expect(await run(ref)).toBe(0);
    expect((await ref.get()).get("alertState")).toEqual({ "10": false });
    expect(send.emails + send.telegrams).toBe(2);

    Object.assign(send, { email: true, telegram: true });
    expect(await run(ref)).toBe(1);
    expect((await ref.get()).get("alertState")).toEqual({ "10": true });

    // Fired and delivered: no repeat while the drawdown holds.
    expect(await run(ref)).toBe(0);
  });

  it("keeps the alert as sent when one channel gets through", async () => {
    const ref = await seed();
    send.email = false;
    expect(await run(ref)).toBe(1);
    expect((await ref.get()).get("alertState")).toEqual({ "10": true });
  });
});

describe("portfolio alerts", () => {
  async function seed() {
    const ref = db.doc("portfolios/alice");
    const doc: PortfolioDoc = {
      ownerId: "alice",
      broker: "IBKR",
      baseCurrency: "USD",
      syncedAt: Timestamp.now(),
      summary: { netLiquidation: 100, cash: 100, buyingPower: null, availableFunds: null, excessLiquidity: null, initialMargin: null, maintenanceMargin: null, leverage: null },
      positions: [],
      history: { dates: ["2026-01-01", "2026-06-01", "2026-11-20"], index: [1, 1.25, 1.0], nav: [null, null, null] },
      livePeak: null,
      thresholds: [10],
      alertsEnabled: true,
      alertState: {},
    };
    await ref.set(doc);
    return ref;
  }
  const run = async (ref: FirebaseFirestore.DocumentReference) =>
    evaluatePortfolioAlerts([{ uid: "alice", ref, data: (await ref.get()).data() as PortfolioDoc }], new Map());

  it("rolls back the fired threshold when every channel fails, then retries", async () => {
    const ref = await seed();
    Object.assign(send, { email: false, telegram: false });
    expect(await run(ref)).toBe(0);
    expect((await ref.get()).get("alertState")).toEqual({ "10": false });

    Object.assign(send, { email: true, telegram: true });
    expect(await run(ref)).toBe(1);
    expect((await ref.get()).get("alertState")).toEqual({ "10": true });
    expect(await run(ref)).toBe(0);
  });

  it("keeps the alert as sent when one channel gets through", async () => {
    const ref = await seed();
    send.telegram = false;
    expect(await run(ref)).toBe(1);
    expect((await ref.get()).get("alertState")).toEqual({ "10": true });
  });
});
