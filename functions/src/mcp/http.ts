import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getAuth } from "firebase-admin/auth";
import * as logger from "firebase-functions/logger";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";
import { quoteRef, refreshQuote } from "../lib/quotes";
import { QuoteDoc } from "../lib/models";
import { getProvider } from "../providers";
import { verifyApiKey } from "./apiKeys";
import { buildMcpServer, McpDeps } from "./server";

/** Cached quotes younger than this are served without calling the provider. */
const QUOTE_MAX_AGE_MS = 5 * 60 * 1000;

const liveDeps: McpDeps = {
  async getQuote(symbol) {
    const snap = await quoteRef(symbol).get();
    const cached = snap.exists ? (snap.data() as QuoteDoc) : null;
    if (cached?.price != null && cached.error == null && Date.now() - cached.updatedAt.toMillis() < QUOTE_MAX_AGE_MS) {
      return cached;
    }
    return refreshQuote(symbol);
  },
  search: (q) => getProvider().search(q),
};

/**
 * Stateless Streamable HTTP MCP endpoint. Each POST carries a bearer API key;
 * a fresh server/transport pair handles the request and is then discarded.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  if (req.method !== "POST") {
    // Stateless server: no SSE stream (GET) or session to delete (DELETE).
    res.status(405).set("Allow", "POST").json(rpcError("Method not allowed"));
    return;
  }

  const auth = req.header("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const uid = key ? await verifyApiKey(key) : null;
  if (!uid) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="drawdown-monitor"')
      .json(rpcError("Missing or invalid API key. Create one in Drawdown Monitor > Settings > MCP access."));
    return;
  }

  let email: string | null = null;
  try {
    const user = await getAuth().getUser(uid);
    email = user.emailVerified && user.email ? user.email.toLowerCase() : null;
  } catch {
    // Deleted account: the key still resolves but there is nothing to show.
    res.status(401).json(rpcError("Account not found."));
    return;
  }

  const server = buildMcpServer({ uid, email }, liveDeps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error("mcp request failed", { uid, err: String(err) });
    if (!res.headersSent) res.status(500).json(rpcError("Internal error"));
  }
}

function rpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}
