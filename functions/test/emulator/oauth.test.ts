/**
 * OAuth for the MCP endpoint, end to end against the Firestore and Auth
 * emulators. The MCP SDK client plays Claude: discovery from the 401,
 * dynamic client registration, PKCE, then tool calls with the access token.
 * The "user" approves through /oauth/approve with a real emulator ID token,
 * exactly as the web app's consent page does.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import express from "express";
import { getAuth } from "firebase-admin/auth";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/firebase";
import { handleMcpRequest } from "../../src/mcp/http";
import { handleOAuthRequest, listGrants, revokeGrant } from "../../src/mcp/oauth";

/** fetch's json() is typed unknown; these tests read known OAuth shapes. */
const json = (r: Response): Promise<any> => r.json();

let base: string;
let close: () => void;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function idTokenFor(uid: string): Promise<string> {
  const custom = await getAuth().createCustomToken(uid);
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  return (await json(r)).idToken;
}

/** What the consent page does when the user clicks Allow (or Cancel). */
async function approve(uid: string, params: Record<string, string>, deny = false) {
  const r = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await idTokenFor(uid)}` },
    body: JSON.stringify({ ...params, deny }),
  });
  return { status: r.status, body: await json(r) };
}

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});

async function register(extra: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], ...extra }),
  });
  return { status: r.status, body: await json(r) };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Register, approve as alice and exchange the code: returns the token response. */
async function fullGrant(clientExtra: Record<string, unknown> = {}) {
  const { body: client } = await register(clientExtra);
  const { verifier, challenge } = pkce();
  const { body } = await approve("alice", {
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
  });
  const code = new URL(body.redirect).searchParams.get("code")!;
  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
  };
  if (client.client_secret) tokenParams.client_secret = client.client_secret;
  const r = await fetch(`${base}/oauth/token`, form(tokenParams));
  return { client, code, verifier, status: r.status, tokens: await json(r) };
}

const mcpPost = (token: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

beforeAll(async () => {
  await getAuth().createUser({ uid: "alice", email: "alice@example.com", emailVerified: true }).catch(() => undefined);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.all("/mcp", (req, res) => void handleMcpRequest(req as any, res));
  app.use((req, res) => void handleOAuthRequest(req as any, res));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.APP_URL = base;
  close = () => srv.close();
});
afterAll(() => close());

beforeEach(async () => {
  for (const c of ["oauthClients", "oauthCodes", "oauthGrants", "oauthTokens"]) await db.recursiveDelete(db.collection(c));
});

describe("discovery", () => {
  it("points a 401 at the protected resource metadata, which names the authorization server", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);

    const prm = await json(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`));
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("MCP SDK client (as Claude)", () => {
  it("discovers, registers, gets approval and calls tools", async () => {
    let client: { client_id: string } | undefined;
    let saved: any;
    let verifier = "";
    let authUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata() {
        return { client_name: "Claude", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
      },
      clientInformation: () => client,
      saveClientInformation: (c) => void (client = c as any),
      tokens: () => saved,
      saveTokens: (t) => void (saved = t),
      redirectToAuthorization: (u) => void (authUrl = u),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    };

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
    const mcp = new Client({ name: "claude-sim", version: "1.0.0" });
    await expect(mcp.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authUrl?.pathname).toBe("/oauth/authorize");
    expect(client?.client_id).toMatch(/^ddc_/);

    // The user approves on the consent page.
    const p = Object.fromEntries(authUrl!.searchParams);
    expect(p.code_challenge_method).toBe("S256");
    const { body } = await approve("alice", p);
    const back = new URL(body.redirect);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    // The SDK client sends no state; when a client does, it is echoed back (see the cancel test).
    expect(back.searchParams.get("state")).toBe(p.state ?? null);

    await transport.finishAuth(back.searchParams.get("code")!);
    const mcp2 = new Client({ name: "claude-sim", version: "1.0.0" });
    await mcp2.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
    const tools = await mcp2.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("save_portfolio_snapshot");
    expect(saved.access_token).toMatch(/^ddo_/);
    expect((await listGrants("alice")).map((g) => g.clientName)).toEqual(["Claude"]);
    await mcp2.close();
  });
});

describe("authorization code", () => {
  it("is single use and needs the right PKCE verifier", async () => {
    const g = await fullGrant();
    expect(g.status).toBe(200);
    expect(g.tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect((await mcpPost(g.tokens.access_token)).status).toBe(200);

    const replay = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, client_id: g.client.client_id }));
    expect(replay.status).toBe(400);
    expect((await json(replay)).error).toBe("invalid_grant");
  });

  it("rejects a wrong verifier", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const { body } = await approve("alice", { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const code = new URL(body.redirect).searchParams.get("code")!;
    const r = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id }));
    expect((await json(r)).error).toBe("invalid_grant");
  });

  it("requires the client secret for confidential clients", async () => {
    const { body: client } = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(client.client_secret).toMatch(/^dds_/);
    const { challenge, verifier } = pkce();
    const { body } = await approve("alice", { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const code = new URL(body.redirect).searchParams.get("code")!;
    const r = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }));
    expect(r.status).toBe(401);
    expect((await fullGrant({ token_endpoint_auth_method: "client_secret_post" })).status).toBe(200);
  });
});

describe("approval", () => {
  it("never returns a redirect to an unregistered address", async () => {
    const { body: client } = await register();
    const r = await approve("alice", { client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(r.status).toBe(400);
    expect(r.body.redirect).toBeUndefined();
    const info = await fetch(`${base}/oauth/client?${new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://evil.example/cb" })}`);
    expect(info.status).toBe(400);
  });

  it("sends access_denied back on cancel, and needs a signed-in user", async () => {
    const { body: client } = await register();
    const r = await approve("alice", { client_id: client.client_id, redirect_uri: REDIRECT, state: "s1" }, true);
    const back = new URL(r.body.redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s1");

    const anon = await fetch(`${base}/oauth/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: client.client_id }) });
    expect(anon.status).toBe(401);
  });

  it("rejects plain http redirect URIs except on loopback", async () => {
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://localhost:33418/callback"] })).status).toBe(201);
  });
});

describe("refresh and revoke", () => {
  it("rotates refresh tokens and stops everything when the user disconnects", async () => {
    const g = await fullGrant();
    const r1 = await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: g.tokens.refresh_token, client_id: g.client.client_id }));
    const t2 = await json(r1);
    expect(r1.status).toBe(200);
    expect(t2.refresh_token).not.toBe(g.tokens.refresh_token);

    // The old refresh token is spent.
    const reuse = await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: g.tokens.refresh_token, client_id: g.client.client_id }));
    expect(reuse.status).toBe(400);

    const [grant] = await listGrants("alice");
    expect(await revokeGrant("bob", grant.id)).toBe(false);
    expect(await revokeGrant("alice", grant.id)).toBe(true);
    expect((await mcpPost(t2.access_token)).status).toBe(401);
    const after = await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: g.client.client_id }));
    expect(after.status).toBe(400);
  });
});
