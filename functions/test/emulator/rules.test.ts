import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

let env: RulesTestEnvironment;

const alice = () => env.authenticatedContext("alice", { email: "alice@example.com", email_verified: true }).firestore();
const bob = () => env.authenticatedContext("bob", { email: "bob@example.com", email_verified: true }).firestore();
const bobUnverified = () => env.authenticatedContext("bob2", { email: "bob@example.com", email_verified: false }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const item = (owner: string, symbol: string) => ({ symbol, ownerId: owner, thresholds: [10, 20], alertsEnabled: true, alertState: {} });

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-drawdown",
    firestore: { rules: readFileSync(resolve(__dirname, "../../../firestore.rules"), "utf8") },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "watchlists/private1"), { ownerId: "alice", name: "Private", isPublic: false, sharedWith: [] });
    await setDoc(doc(db, "watchlists/shared1"), { ownerId: "alice", name: "Shared", isPublic: false, sharedWith: ["bob@example.com"] });
    await setDoc(doc(db, "watchlists/public1"), { ownerId: "alice", name: "Public", isPublic: true, sharedWith: [] });
    for (const w of ["private1", "shared1", "public1"]) await setDoc(doc(db, `watchlists/${w}/items/AAPL`), item("alice", "AAPL"));
    await setDoc(doc(db, "quotes/AAPL"), { symbol: "AAPL", price: 1 });
    await setDoc(doc(db, "users/alice"), { email: "alice@example.com", telegramChatId: 123 });
  });
});

describe("watchlists", () => {
  it("owner can create, read, update, delete", async () => {
    const db = alice();
    await assertSucceeds(setDoc(doc(db, "watchlists/new"), { ownerId: "alice", name: "X", isPublic: false, sharedWith: [] }));
    await assertSucceeds(getDoc(doc(db, "watchlists/private1")));
    await assertSucceeds(updateDoc(doc(db, "watchlists/private1"), { name: "Renamed" }));
    await assertSucceeds(updateDoc(doc(db, "watchlists/private1"), { dailySummary: true }));
    await assertFails(updateDoc(doc(db, "watchlists/private1"), { dailySummary: "yes" }));
    await assertFails(updateDoc(doc(bob(), "watchlists/private1"), { dailySummary: true }));
    await assertSucceeds(deleteDoc(doc(db, "watchlists/private1")));
  });

  it("cannot create a list for someone else or with invalid fields", async () => {
    await assertFails(setDoc(doc(bob(), "watchlists/x"), { ownerId: "alice", name: "X", isPublic: false, sharedWith: [] }));
    await assertFails(setDoc(doc(alice(), "watchlists/y"), { ownerId: "alice", name: "", isPublic: false, sharedWith: [] }));
    await assertFails(setDoc(doc(alice(), "watchlists/z"), { ownerId: "alice", name: "Z" }));
  });

  it("private lists are hidden from others", async () => {
    await assertFails(getDoc(doc(bob(), "watchlists/private1")));
    await assertFails(getDoc(doc(anon(), "watchlists/private1")));
    await assertFails(getDocs(collection(bob(), "watchlists/private1/items")));
  });

  it("shared lists are readable by verified recipients only", async () => {
    await assertSucceeds(getDoc(doc(bob(), "watchlists/shared1")));
    await assertSucceeds(getDocs(collection(bob(), "watchlists/shared1/items")));
    await assertSucceeds(getDocs(query(collection(bob(), "watchlists"), where("sharedWith", "array-contains", "bob@example.com"))));
    await assertFails(getDoc(doc(bobUnverified(), "watchlists/shared1")));
  });

  it("recipients cannot modify shared lists or add themselves elsewhere", async () => {
    await assertFails(updateDoc(doc(bob(), "watchlists/shared1"), { name: "Hacked" }));
    await assertFails(setDoc(doc(bob(), "watchlists/shared1/items/MSFT"), item("bob", "MSFT")));
    await assertFails(deleteDoc(doc(bob(), "watchlists/shared1/items/AAPL")));
    await assertFails(updateDoc(doc(bob(), "watchlists/private1"), { sharedWith: arrayUnion("bob@example.com") }));
    await assertFails(updateDoc(doc(alice(), "watchlists/private1"), { ownerId: "bob" }));
  });

  it("public lists are readable by link but not enumerable", async () => {
    await assertSucceeds(getDoc(doc(anon(), "watchlists/public1")));
    await assertSucceeds(getDocs(collection(anon(), "watchlists/public1/items")));
    await assertFails(getDocs(query(collection(anon(), "watchlists"), where("isPublic", "==", true))));
    await assertFails(getDocs(query(collection(bob(), "watchlists"), where("isPublic", "==", true))));
  });

  it("owner can only list their own lists", async () => {
    await assertSucceeds(getDocs(query(collection(alice(), "watchlists"), where("ownerId", "==", "alice"))));
    await assertFails(getDocs(query(collection(bob(), "watchlists"), where("ownerId", "==", "alice"))));
  });
});

describe("items", () => {
  it("owner can add items whose id matches the symbol", async () => {
    await assertSucceeds(setDoc(doc(alice(), "watchlists/private1/items/^GSPC"), item("alice", "^GSPC")));
    await assertFails(setDoc(doc(alice(), "watchlists/private1/items/MSFT"), item("alice", "AAPL")));
    await assertFails(setDoc(doc(alice(), "watchlists/private1/items/MSFT"), item("bob", "MSFT")));
  });
});

describe("quotes", () => {
  it("are public read and server-write only", async () => {
    await assertSucceeds(getDoc(doc(anon(), "quotes/AAPL")));
    await assertFails(setDoc(doc(alice(), "quotes/AAPL"), { price: 999 }));
  });
});

describe("users", () => {
  it("can only read and write their own profile", async () => {
    await assertSucceeds(getDoc(doc(alice(), "users/alice")));
    await assertFails(getDoc(doc(bob(), "users/alice")));
    await assertSucceeds(setDoc(doc(bob(), "users/bob"), { email: "bob@example.com", athBasis: "close" }));
  });

  it("cannot set Telegram link fields", async () => {
    await assertFails(updateDoc(doc(alice(), "users/alice"), { telegramChatId: 999 }));
    await assertFails(setDoc(doc(bob(), "users/bob"), { email: "bob@example.com", telegramChatId: 5 }));
    await assertSucceeds(updateDoc(doc(alice(), "users/alice"), { telegramLinkCode: "abcdefghijklmnopqrstuvwx" }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { telegramLinkCode: "short" }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { athBasis: "weird" }));
    await assertSucceeds(updateDoc(doc(alice(), "users/alice"), { summaryHour: 7, summaryMinute: 45, summaryTimeZone: "Asia/Singapore" }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { summaryHour: 24 }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { summaryMinute: 60 }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { summaryHour: "7" }));
  });
});
