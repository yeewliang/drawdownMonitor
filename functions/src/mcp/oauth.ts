/**
 * OAuth 2.1 authorization server for the MCP endpoint, so Claude on the web,
 * mobile and desktop can add Drawdown Monitor as a custom connector.
 *
 * - Discovery: RFC 9728 protected resource metadata and RFC 8414 authorization
 *   server metadata, both served from the app's public origin (APP_URL), which
 *   Vercel rewrites to this function.
 * - Clients register themselves (RFC 7591 dynamic client registration).
 * - The authorization page is the web app's /oauth/authorize route: the user
 *   signs in with Firebase (Google) there, and the page calls /oauth/approve
 *   with their Firebase ID token to get a one-time code.
 * - Authorization code + PKCE (S256 only) and rotating refresh tokens.
 *
 * Codes and tokens are random and stored only as SHA-256 hashes. All these
 * collections are server-only (no Firestore rule allows client access).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Request } from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import { APP_URL } from "../config";
import { db } from "../lib/firebase";

export const ACCESS_PREFIX = "ddo_";
const REFRESH_PREFIX = "ddr_";
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SCOPE = "mcp";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rand = (n = 32) => randomBytes(n).toString("base64url");
const clients = () => db.collection("oauthClients");
const codes = () => db.collection("oauthCodes");
const grants = () => db.collection("oauthGrants");
const tokens = () => db.collection("oauthTokens");

export interface OAuthClientDoc {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  secretHash: string | null;
  createdAt: Timestamp;
}

interface CodeDoc {
  clientId: string;
  uid: string;
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  expiresAt: Timestamp;
}

export interface GrantDoc {
  uid: string;
  clientId: string;
  clientName: string;
  createdAt: Timestamp;
  lastUsedAt: Timestamp | null;
}

interface TokenDoc {
  kind: "access" | "refresh";
  uid: string;
  clientId: string;
  grantId: string;
  expiresAt: Timestamp;
  /** Set when a refresh token has been exchanged; kept for reuse detection until it expires. */
  consumedAt?: Timestamp;
}

/** Public origin, e.g. https://drawdown-monitor.vercel.app (no trailing slash). */
export const origin = () => APP_URL.value().replace(/\/+$/, "");
export const resourceUrl = () => `${origin()}/mcp`;
export const resourceMetadataUrl = () => `${origin()}/.well-known/oauth-protected-resource`;

export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [origin()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Drawdown Monitor",
  };
}

export function authorizationServerMetadata() {
  const o = origin();
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  };
}

// ---------------------------------------------------------------- validation

/** RFC 8707 resource indicator: only this server's MCP endpoint (trailing slash tolerated). */
export function isOurResource(raw: unknown): boolean {
  return typeof raw === "string" && raw.replace(/\/+$/, "") === resourceUrl();
}

/** https anywhere; http only for loopback (local clients such as Claude Code). */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------- registration

export async function registerClient(body: Record<string, unknown>) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be 1-10 https URLs (or http on localhost).");
  }
  const method = (body.token_endpoint_auth_method ?? "none") as string;
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    throw new OAuthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
  }
  const grantTypes = (body.grant_types as string[] | undefined) ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || grantTypes.some((g) => !["authorization_code", "refresh_token"].includes(g))) {
    throw new OAuthError("invalid_client_metadata", "Unsupported grant_types.");
  }
  const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "MCP client";
  const clientId = `ddc_${rand(16)}`;
  const secret = method === "none" ? null : `dds_${rand()}`;
  const doc: OAuthClientDoc = {
    clientName,
    redirectUris: uris as string[],
    tokenEndpointAuthMethod: method as OAuthClientDoc["tokenEndpointAuthMethod"],
    secretHash: secret ? sha(secret) : null,
    createdAt: Timestamp.now(),
  };
  await clients().doc(clientId).create(doc);
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(doc.createdAt.toMillis() / 1000),
    client_name: clientName,
    redirect_uris: doc.redirectUris,
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE,
  };
}

async function loadClient(clientId: unknown): Promise<OAuthClientDoc> {
  if (typeof clientId !== "string" || !/^ddc_[\w-]{10,40}$/.test(clientId)) throw new OAuthError("invalid_client", "Unknown client.", 401);
  const snap = await clients().doc(clientId).get();
  if (!snap.exists) throw new OAuthError("invalid_client", "Unknown client.", 401);
  return snap.data() as OAuthClientDoc;
}

/** For the consent page: the client's name, once its redirect URI checks out. */
export async function describeClient(clientId: unknown, redirectUri: unknown) {
  const c = await loadClient(clientId);
  if (typeof redirectUri !== "string" || !c.redirectUris.includes(redirectUri)) {
    throw new OAuthError("invalid_request", "This redirect address is not registered for the app.");
  }
  return { client_name: c.clientName, redirect_host: new URL(redirectUri).host };
}

// ---------------------------------------------------------------- approval

export interface ApproveInput {
  client_id?: unknown;
  redirect_uri?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  state?: unknown;
  scope?: unknown;
  resource?: unknown;
  deny?: unknown;
}

/**
 * Called by the web app's consent page with the signed-in user's uid.
 * Returns the URL to send the browser to: the client's redirect URI with a
 * code (approve) or error=access_denied (deny). Invalid client or redirect
 * URI throws, so the page never redirects to an unregistered address.
 */
export async function approve(uid: string, input: ApproveInput): Promise<string> {
  const c = await loadClient(input.client_id);
  const redirectUri = input.redirect_uri;
  if (typeof redirectUri !== "string" || !c.redirectUris.includes(redirectUri)) {
    throw new OAuthError("invalid_request", "This redirect address is not registered for the app.");
  }
  if (typeof input.state === "string" && input.state.length > 2000) {
    throw new OAuthError("invalid_request", "The state parameter is too long.");
  }
  const target = new URL(redirectUri);
  // state is opaque to us and goes back unchanged.
  if (typeof input.state === "string" && input.state) target.searchParams.set("state", input.state);
  target.searchParams.set("iss", origin());

  if (input.deny === true) {
    target.searchParams.set("error", "access_denied");
    return target.toString();
  }
  const challenge = input.code_challenge;
  if (input.code_challenge_method !== "S256" || typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    target.searchParams.set("error", "invalid_request");
    target.searchParams.set("error_description", "PKCE with S256 is required.");
    return target.toString();
  }

  if (input.resource !== undefined && input.resource !== null && input.resource !== "" && !isOurResource(input.resource)) {
    target.searchParams.set("error", "invalid_target");
    target.searchParams.set("error_description", `Only ${resourceUrl()} can be authorized here.`);
    return target.toString();
  }

  const clientId = input.client_id as string;
  const existing = await grants().where("uid", "==", uid).where("clientId", "==", clientId).limit(1).get();
  const grantId = existing.empty ? grants().doc().id : existing.docs[0].id;
  if (existing.empty) {
    const g: GrantDoc = { uid, clientId, clientName: c.clientName, createdAt: Timestamp.now(), lastUsedAt: null };
    await grants().doc(grantId).set(g);
  }

  const code = rand();
  const doc: CodeDoc = {
    clientId,
    uid,
    grantId,
    redirectUri,
    codeChallenge: challenge,
    scope: SCOPE,
    resource: typeof input.resource === "string" && input.resource ? resourceUrl() : null,
    expiresAt: Timestamp.fromMillis(Date.now() + CODE_TTL_MS),
  };
  await codes().doc(sha(code)).create(doc);
  target.searchParams.set("code", code);
  return target.toString();
}

// ---------------------------------------------------------------- token endpoint

function clientCredentials(req: Request, body: Record<string, unknown>): { id: unknown; secret: string | null } {
  const basic = req.header("authorization");
  if (basic?.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(basic.slice(6), "base64").toString().split(":");
    return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
  }
  return { id: body.client_id, secret: typeof body.client_secret === "string" ? body.client_secret : null };
}

function checkSecret(c: OAuthClientDoc, secret: string | null) {
  if (c.tokenEndpointAuthMethod === "none") return;
  if (!secret || !c.secretHash) throw new OAuthError("invalid_client", "Client authentication failed.", 401);
  const a = Buffer.from(sha(secret));
  const b = Buffer.from(c.secretHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthError("invalid_client", "Client authentication failed.", 401);
}

async function issueTokens(uid: string, clientId: string, grantId: string) {
  const access = ACCESS_PREFIX + rand();
  const refresh = REFRESH_PREFIX + rand();
  const now = Date.now();
  const batch = db.batch();
  batch.set(tokens().doc(sha(access)), { kind: "access", uid, clientId, grantId, expiresAt: Timestamp.fromMillis(now + ACCESS_TTL_S * 1000) } satisfies TokenDoc);
  batch.set(tokens().doc(sha(refresh)), { kind: "refresh", uid, clientId, grantId, expiresAt: Timestamp.fromMillis(now + REFRESH_TTL_MS) } satisfies TokenDoc);
  batch.update(grants().doc(grantId), { lastUsedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

export async function tokenRequest(req: Request, body: Record<string, unknown>) {
  const creds = clientCredentials(req, body);
  const c = await loadClient(creds.id);
  checkSecret(c, creds.secret);
  const clientId = creds.id as string;

  if (body.grant_type === "authorization_code") {
    if (typeof body.code !== "string" || typeof body.code_verifier !== "string") {
      throw new OAuthError("invalid_request", "code and code_verifier are required.");
    }
    if (body.resource !== undefined && body.resource !== "" && !isOurResource(body.resource)) {
      throw new OAuthError("invalid_target", `Only ${resourceUrl()} can be requested here.`);
    }
    const ref = codes().doc(sha(body.code));
    const verifierHash = createHash("sha256").update(body.code_verifier).digest("base64url");
    // Check every binding before consuming the code, so a request that is not
    // the legitimate client's (wrong client, redirect or verifier) can't burn it.
    const code = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new OAuthError("invalid_grant", "The code is invalid or expired.");
      const c = snap.data() as CodeDoc;
      if (c.expiresAt.toMillis() < Date.now() || c.clientId !== clientId) throw new OAuthError("invalid_grant", "The code is invalid or expired.");
      if (body.redirect_uri !== undefined && body.redirect_uri !== c.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match.");
      if (verifierHash !== c.codeChallenge) throw new OAuthError("invalid_grant", "PKCE verification failed.");
      tx.delete(ref);
      return c;
    });
    if (!(await grants().doc(code.grantId).get()).exists) throw new OAuthError("invalid_grant", "Access was revoked.");
    return issueTokens(code.uid, clientId, code.grantId);
  }

  if (body.grant_type === "refresh_token") {
    if (typeof body.refresh_token !== "string" || !body.refresh_token.startsWith(REFRESH_PREFIX)) {
      throw new OAuthError("invalid_grant", "Invalid refresh token.");
    }
    if (body.resource !== undefined && body.resource !== "" && !isOurResource(body.resource)) {
      throw new OAuthError("invalid_target", `Only ${resourceUrl()} can be requested here.`);
    }
    const ref = tokens().doc(sha(body.refresh_token));
    // Rotation. Ownership, kind and expiry are checked before anything is
    // changed. A used refresh token is kept, marked consumed: presenting it
    // again means it was copied, so the whole grant is revoked (RFC 9700).
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false as const };
      const t = snap.data() as TokenDoc;
      if (t.kind !== "refresh" || t.clientId !== clientId || t.expiresAt.toMillis() < Date.now()) return { ok: false as const };
      if (t.consumedAt) return { ok: false as const, replayOf: t.grantId };
      tx.update(ref, { consumedAt: Timestamp.now() });
      return { ok: true as const, token: t };
    });
    if (!outcome.ok) {
      if (outcome.replayOf) {
        logger.warn("refresh token reuse: revoking grant", { grantId: outcome.replayOf });
        await deleteGrant(outcome.replayOf);
      }
      throw new OAuthError("invalid_grant", "Invalid refresh token.");
    }
    const old = outcome.token;
    if (!(await grants().doc(old.grantId).get()).exists) throw new OAuthError("invalid_grant", "Access was revoked.");
    return issueTokens(old.uid, clientId, old.grantId);
  }

  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** Resolve an OAuth access token to its user, or null. */
export async function verifyAccessToken(token: string): Promise<string | null> {
  if (!token.startsWith(ACCESS_PREFIX) || token.length > 100) return null;
  const snap = await tokens().doc(sha(token)).get();
  if (!snap.exists) return null;
  const t = snap.data() as TokenDoc;
  if (t.kind !== "access" || t.expiresAt.toMillis() < Date.now()) return null;
  // A token issued while a Disconnect was deleting tokens would be missed by
  // that sweep; requiring the grant closes the gap.
  if (!(await grants().doc(t.grantId).get()).exists) return null;
  return t.uid;
}

// ---------------------------------------------------------------- grants (Settings page)

export interface GrantInfo {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listGrants(uid: string): Promise<GrantInfo[]> {
  const snap = await grants().where("uid", "==", uid).get();
  return snap.docs
    .map((d) => {
      const g = d.data() as GrantDoc;
      return { id: d.id, clientName: g.clientName, createdAt: g.createdAt.toDate().toISOString(), lastUsedAt: g.lastUsedAt?.toDate().toISOString() ?? null };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Delete a grant and every token issued under it. */
export async function revokeGrant(uid: string, grantId: string): Promise<boolean> {
  const snap = await grants().doc(grantId).get();
  if (!snap.exists || snap.get("uid") !== uid) return false;
  await deleteGrant(grantId);
  return true;
}

/**
 * The grant goes first: tokens are only honoured while their grant exists, so
 * anything issued during the sweep below is already dead.
 */
async function deleteGrant(grantId: string): Promise<void> {
  await grants().doc(grantId).delete();
  const writer = db.bulkWriter();
  for (const d of (await tokens().where("grantId", "==", grantId).get()).docs) writer.delete(d.ref);
  for (const d of (await codes().where("grantId", "==", grantId).get()).docs) writer.delete(d.ref);
  await writer.close();
}

/** Remove expired codes and tokens, and clients nobody authorized within a week. */
export async function cleanupOAuth(): Promise<{ deleted: number }> {
  const now = Timestamp.now();
  const writer = db.bulkWriter();
  let deleted = 0;
  for (const col of [codes(), tokens()]) {
    for (const d of (await col.where("expiresAt", "<", now).limit(2000).get()).docs) {
      writer.delete(d.ref);
      deleted++;
    }
  }
  const weekAgo = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
  for (const d of (await clients().where("createdAt", "<", weekAgo).limit(500).get()).docs) {
    const used = await grants().where("clientId", "==", d.id).limit(1).get();
    if (used.empty) {
      writer.delete(d.ref);
      deleted++;
    }
  }
  await writer.close();
  return { deleted };
}

// ---------------------------------------------------------------- HTTP

/**
 * The `oauth` function. Vercel rewrites these public paths to it:
 *   /.well-known/oauth-protected-resource[/mcp]
 *   /.well-known/oauth-authorization-server
 *   /oauth/register, /oauth/token, /oauth/client, /oauth/approve
 */
export async function handleOAuthRequest(req: Request, res: Response): Promise<void> {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  const path = req.path.replace(/\/+$/, "") || "/";
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  try {
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      res.json(protectedResourceMetadata());
      return;
    }
    if (req.method === "GET" && (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration"))) {
      res.json(authorizationServerMetadata());
      return;
    }
    if (req.method === "POST" && path === "/oauth/register") {
      res.status(201).json(await registerClient(body));
      return;
    }
    if (req.method === "POST" && path === "/oauth/token") {
      res.json(await tokenRequest(req, body));
      return;
    }
    if (req.method === "GET" && path === "/oauth/client") {
      res.json(await describeClient(req.query.client_id, req.query.redirect_uri));
      return;
    }
    if (req.method === "POST" && path === "/oauth/approve") {
      const idToken = (req.header("authorization") ?? "").replace(/^Bearer\s+/, "");
      let uid: string;
      try {
        uid = (await getAuth().verifyIdToken(idToken)).uid;
      } catch {
        throw new OAuthError("login_required", "Sign in again and retry.", 401);
      }
      res.json({ redirect: await approve(uid, body as ApproveInput) });
      return;
    }
    res.status(404).json({ error: "not_found" });
  } catch (err) {
    if (err instanceof OAuthError) {
      res.status(err.status).json({ error: err.code, error_description: err.message });
      return;
    }
    logger.error("oauth request failed", { path, err: String(err) });
    res.status(500).json({ error: "server_error" });
  }
}
