import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { getAuth } from "firebase-admin/auth";
import { Timestamp } from "firebase-admin/firestore";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/firebase";
import { QuoteDoc } from "../../src/lib/models";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "../../src/mcp/apiKeys";
import { handleMcpRequest } from "../../src/mcp/http";
import { buildMcpServer, McpCaller, McpDeps } from "../../src/mcp/server";

const ts = (iso: string) => Timestamp.fromDate(new Date(iso));
const quote = (symbol: string, price: number, ath: number): QuoteDoc => ({
  symbol,
  name: `${symbol} name`,
  currency: "USD",
  exchange: "TEST",
  instrumentType: "EQUITY",
  timezone: "America/New_York",
  price,
  previousClose: price,
  changePct: 0,
  marketTime: Timestamp.now(),
  sessionOpen: false,
  athIntraday: ath * 1.01,
  athIntradayDate: ts("2026-01-02"),
  athClose: ath,
  athCloseDate: ts("2026-01-02"),
  drawdownIntradayPct: (1 - price / (ath * 1.01)) * 100,
  drawdownClosePct: (1 - price / ath) * 100,
  provider: "fake",
  historyRefreshedAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  error: null,
});

const fakeQuotes: Record<string, QuoteDoc> = { AAPL: quote("AAPL", 90, 100), "^GSPC": quote("^GSPC", 70, 100) };
const deps: McpDeps = {
  getQuote: async (s) => fakeQuotes[s] ?? null,
  search: async (q) => [{ symbol: "^N225", name: `Nikkei (${q})`, type: "Index", exchange: "OSA" }],
};

async function connect(caller: McpCaller) {
  const server = buildMcpServer(caller, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  return { error: r.isError === true, data: r.structuredContent, text: r.content?.[0]?.text as string };
}

beforeEach(async () => {
  await db.recursiveDelete(db.collection("watchlists"));
  await db.recursiveDelete(db.collection("apiKeys"));
  await db.doc("users/alice").set({ email: "alice@example.com", displayName: "Alice", athBasis: "close" });
  await db.doc("watchlists/mine").set({ ownerId: "alice", name: "Mine", isPublic: false, sharedWith: [] });
  await db.doc("watchlists/mine/items/AAPL").set({ symbol: "AAPL", ownerId: "alice", thresholds: [5, 20], alertsEnabled: true, alertState: { "5": true } });
  await db.doc("watchlists/mine/items/^GSPC").set({ symbol: "^GSPC", ownerId: "alice", thresholds: [10], alertsEnabled: true, alertState: {} });
  await db.doc("watchlists/bobs").set({ ownerId: "bob", ownerName: "Bob", name: "Bob shared", isPublic: false, sharedWith: ["alice@example.com"] });
  await db.doc("watchlists/secret").set({ ownerId: "bob", name: "Bob private", isPublic: false, sharedWith: [] });
  for (const [s, q] of Object.entries(fakeQuotes)) await db.doc(`quotes/${s}`).set(q);
});

describe("MCP tools", () => {
  it("lists own and shared watchlists", async () => {
    const c = await connect({ uid: "alice", email: "alice@example.com" });
    const { data } = await call(c, "list_watchlists");
    expect(data.watchlists.map((w: any) => `${w.id}:${w.role}`).sort()).toEqual(["bobs:viewer", "mine:owner"]);
  });

  it("hides shared lists when the email is not verified", async () => {
    const c = await connect({ uid: "alice", email: null });
    const { data } = await call(c, "list_watchlists");
    expect(data.watchlists.map((w: any) => w.id)).toEqual(["mine"]);
  });

  it("returns drawdowns sorted deepest first", async () => {
    const c = await connect({ uid: "alice", email: "alice@example.com" });
    const { data } = await call(c, "get_watchlist", { watchlist_id: "mine" });
    expect(data.symbols.map((s: any) => s.symbol)).toEqual(["^GSPC", "AAPL"]);
    expect(data.symbols[1].drawdownPct).toBeCloseTo(10);
    expect(data.symbols[1].alertsTriggered).toEqual([5]);
  });

  it("refuses lists the caller cannot see", async () => {
    const c = await connect({ uid: "alice", email: "alice@example.com" });
    const r = await call(c, "get_watchlist", { watchlist_id: "secret" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it("adds, updates and removes symbols on own lists", async () => {
    const c = await connect({ uid: "alice", email: "alice@example.com" });
    await db.doc("watchlists/mine/items/AAPL").delete();
    const add = await call(c, "add_symbol", { watchlist_id: "mine", symbol: "aapl", thresholds: [30, 15, 15] });
    expect(add.data).toMatchObject({ added: true, symbol: "AAPL", alertThresholds: [15, 30] });
    expect((await call(c, "add_symbol", { watchlist_id: "mine", symbol: "AAPL" })).data.added).toBe(false);

    const set = await call(c, "set_alerts", { watchlist_id: "mine", symbol: "AAPL", thresholds: [25], enabled: false });
    expect(set.data).toEqual({ symbol: "AAPL", alertThresholds: [25], alertsEnabled: false });
    expect((await db.doc("watchlists/mine/items/AAPL").get()).get("alertState")).toEqual({});

    expect((await call(c, "remove_symbol", { watchlist_id: "mine", symbol: "AAPL" })).data.removed).toBe(true);
    expect((await db.doc("watchlists/mine/items/AAPL").get()).exists).toBe(false);
  });

  it("rejects unknown symbols and writes to shared lists", async () => {
    const c = await connect({ uid: "alice", email: "alice@example.com" });
    expect((await call(c, "add_symbol", { watchlist_id: "mine", symbol: "NOPE" })).error).toBe(true);
    const r = await call(c, "add_symbol", { watchlist_id: "bobs", symbol: "AAPL" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/read-only/);
    expect((await call(c, "remove_symbol", { watchlist_id: "secret", symbol: "AAPL" })).error).toBe(true);
  });

  it("creates watchlists and gets single-symbol drawdowns", async () => {
    const c = await connect({ uid: "alice", email: "alice@example.com" });
    const { data } = await call(c, "create_watchlist", { name: "New" });
    expect((await db.doc(`watchlists/${data.id}`).get()).get("ownerId")).toBe("alice");
    const dd = await call(c, "get_drawdown", { symbol: "^gspc" });
    expect(dd.data.drawdownFromClosingAthPct).toBeCloseTo(30);
    expect((await call(c, "search_symbols", { query: "nikkei" })).data.results[0].symbol).toBe("^N225");
  });
});

describe("API keys", () => {
  it("creates, verifies, lists and revokes", async () => {
    const { key, info } = await createApiKey("alice", "laptop");
    expect(key).toMatch(/^ddm_/);
    expect(await verifyApiKey(key)).toBe("alice");
    expect(await verifyApiKey(key + "x")).toBeNull();
    expect((await listApiKeys("alice")).map((k) => k.name)).toEqual(["laptop"]);
    expect(await revokeApiKey("bob", info.id)).toBe(false);
    expect(await revokeApiKey("alice", info.id)).toBe(true);
    expect(await verifyApiKey(key)).toBeNull();
  });
});

describe("HTTP endpoint", () => {
  let url: string;
  let close: () => void;

  beforeAll(async () => {
    await getAuth().createUser({ uid: "alice", email: "alice@example.com", emailVerified: true }).catch(() => undefined);
    const app = express();
    app.use(express.json());
    app.all("/mcp", (req, res) => void handleMcpRequest(req as any, res));
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    close = () => srv.close();
  });
  afterAll(() => close());

  it("rejects requests without a valid key", async () => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const bad = await fetch(url, { method: "POST", headers: { Authorization: "Bearer ddm_wrong" }, body: "{}" });
    expect(bad.status).toBe(401);
  });

  it("serves tools to an MCP client with a valid key", async () => {
    const { key } = await createApiKey("alice", "test");
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ["add_symbol", "create_watchlist", "get_drawdown", "get_watchlist", "list_watchlists", "remove_symbol", "search_symbols", "set_alerts"],
    );
    const r: any = await client.callTool({ name: "list_watchlists", arguments: {} });
    expect(r.structuredContent.watchlists).toHaveLength(2);
    await client.close();
  });
});
