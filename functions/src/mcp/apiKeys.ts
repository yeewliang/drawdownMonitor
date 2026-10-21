import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/firebase";

/**
 * Personal API keys for the MCP endpoint. Only a SHA-256 hash of each key is
 * stored (as the doc ID of apiKeys/{hash}); the plaintext is shown once.
 * The collection is not readable or writable by clients.
 */
const KEY_PREFIX = "ddm_";
const MAX_KEYS_PER_USER = 10;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

export interface ApiKeyDoc {
  uid: string;
  name: string;
  /** First characters of the key, shown in the UI to tell keys apart. */
  hint: string;
  createdAt: Timestamp;
  lastUsedAt: Timestamp | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const keys = () => db.collection("apiKeys");

export async function createApiKey(uid: string, name: string): Promise<{ key: string; info: ApiKeyInfo }> {
  const existing = await keys().where("uid", "==", uid).count().get();
  if (existing.data().count >= MAX_KEYS_PER_USER) {
    throw new Error(`You can have at most ${MAX_KEYS_PER_USER} API keys. Revoke one first.`);
  }
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const doc: ApiKeyDoc = {
    uid,
    name: name.trim().slice(0, 60) || "API key",
    hint: key.slice(0, KEY_PREFIX.length + 6),
    createdAt: Timestamp.now(),
    lastUsedAt: null,
  };
  const id = hashKey(key);
  await keys().doc(id).create(doc);
  return { key, info: toInfo(id, doc) };
}

export async function listApiKeys(uid: string): Promise<ApiKeyInfo[]> {
  const snap = await keys().where("uid", "==", uid).get();
  return snap.docs
    .map((d) => toInfo(d.id, d.data() as ApiKeyDoc))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function revokeApiKey(uid: string, id: string): Promise<boolean> {
  const ref = keys().doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.get("uid") !== uid) return false;
  await ref.delete();
  return true;
}

/** Resolve a presented key to its owner's uid, or null if it is not valid. */
export async function verifyApiKey(key: string): Promise<string | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  const ref = keys().doc(hashKey(key));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as ApiKeyDoc;
  // Record usage at most hourly to avoid a write on every request.
  if (!data.lastUsedAt || Date.now() - data.lastUsedAt.toMillis() > LAST_USED_RESOLUTION_MS) {
    await ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
  }
  return data.uid;
}

function toInfo(id: string, d: ApiKeyDoc): ApiKeyInfo {
  return {
    id,
    name: d.name,
    hint: d.hint,
    createdAt: d.createdAt.toDate().toISOString(),
    lastUsedAt: d.lastUsedAt ? d.lastUsedAt.toDate().toISOString() : null,
  };
}
