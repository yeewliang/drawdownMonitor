import type { User } from "firebase/auth";
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase";
import type { SymbolMatch, UserProfile, WatchItem, Watchlist } from "./types";

export const DEFAULT_THRESHOLDS = [10, 20, 30];

// ---------------------------------------------------------------- users

export async function ensureUserProfile(user: User): Promise<void> {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  const base = { email: user.email?.toLowerCase() ?? null, displayName: user.displayName ?? null };
  if (!snap.exists()) {
    await setDoc(ref, { ...base, athBasis: "close", notifyEmail: true, notifyTelegram: true, createdAt: serverTimestamp() });
  } else if (snap.get("email") !== base.email || snap.get("displayName") !== base.displayName) {
    await updateDoc(ref, base);
  }
}

export function updateUserProfile(uid: string, data: Partial<UserProfile>) {
  return updateDoc(doc(db, "users", uid), data);
}

/** Create a one-time code and return the Telegram deep link that redeems it. */
export async function createTelegramLink(uid: string, botUsername: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await updateDoc(doc(db, "users", uid), { telegramLinkCode: code });
  return `https://t.me/${botUsername}?start=${code}`;
}

// ---------------------------------------------------------------- watchlists

const ownerLabel = (u: User) => u.displayName || u.email || "Someone";

export async function createWatchlist(user: User, name: string): Promise<string> {
  const ref = doc(collection(db, "watchlists"));
  await setDoc(ref, {
    ownerId: user.uid,
    ownerName: ownerLabel(user),
    name: name.trim().slice(0, 80) || "My watchlist",
    isPublic: false,
    sharedWith: [],
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function updateWatchlist(id: string, data: Partial<Pick<Watchlist, "name" | "isPublic" | "dailySummary">>) {
  return updateDoc(doc(db, "watchlists", id), data);
}

export function shareWith(id: string, email: string) {
  return updateDoc(doc(db, "watchlists", id), { sharedWith: arrayUnion(email.trim().toLowerCase()) });
}

export function unshareWith(id: string, email: string) {
  return updateDoc(doc(db, "watchlists", id), { sharedWith: arrayRemove(email) });
}

/** Items are removed server-side by the onWatchlistDeleted function. */
export function deleteWatchlist(id: string) {
  return deleteDoc(doc(db, "watchlists", id));
}

/** Copy a (shared or public) watchlist into the user's own lists. */
export async function copyWatchlist(user: User, source: Watchlist): Promise<string> {
  const items = await getDocs(collection(db, "watchlists", source.id, "items"));
  const newId = await createWatchlist(user, `${source.name} (copy)`);
  const batch = writeBatch(db);
  items.docs.forEach((d) => {
    const it = d.data() as WatchItem;
    batch.set(doc(db, "watchlists", newId, "items", d.id), {
      symbol: it.symbol,
      ownerId: user.uid,
      thresholds: it.thresholds ?? DEFAULT_THRESHOLDS,
      alertsEnabled: true,
      alertState: {},
      addedAt: serverTimestamp(),
    });
  });
  await batch.commit();
  return newId;
}

// ---------------------------------------------------------------- items

export function addItem(watchlistId: string, uid: string, symbol: string, thresholds = DEFAULT_THRESHOLDS) {
  return setDoc(doc(db, "watchlists", watchlistId, "items", symbol), {
    symbol,
    ownerId: uid,
    thresholds,
    alertsEnabled: true,
    alertState: {},
    addedAt: serverTimestamp(),
  });
}

/** Changing thresholds resets alert state so the new levels fire fresh. */
export function updateItem(watchlistId: string, symbol: string, data: Partial<Pick<WatchItem, "thresholds" | "alertsEnabled" | "note">>) {
  const patch: Record<string, unknown> = { ...data };
  if (data.thresholds) patch.alertState = {};
  return updateDoc(doc(db, "watchlists", watchlistId, "items", symbol), patch);
}

export function removeItem(watchlistId: string, symbol: string) {
  return deleteDoc(doc(db, "watchlists", watchlistId, "items", symbol));
}

// ---------------------------------------------------------------- callables

export async function searchSymbols(query: string): Promise<SymbolMatch[]> {
  const fn = httpsCallable<{ query: string }, { results: SymbolMatch[] }>(functions, "searchSymbols");
  return (await fn({ query })).data.results;
}

export async function sendTestAlert(): Promise<{ email: string; telegram: string }> {
  const fn = httpsCallable<void, { email: string; telegram: string }>(functions, "sendTestAlert");
  return (await fn()).data;
}

export async function unlinkTelegram(): Promise<void> {
  await httpsCallable(functions, "unlinkTelegram")();
}

// ---------------------------------------------------------------- MCP API keys

export interface ApiKeyInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function createApiKey(name: string): Promise<{ key: string; info: ApiKeyInfo }> {
  return (await httpsCallable<{ name: string }, { key: string; info: ApiKeyInfo }>(functions, "createApiKey")({ name })).data;
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  return (await httpsCallable<void, { keys: ApiKeyInfo[] }>(functions, "listApiKeys")()).data.keys;
}

export async function revokeApiKey(id: string): Promise<void> {
  await httpsCallable(functions, "revokeApiKey")({ id });
}
