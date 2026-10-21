import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { AthBasis } from "../lib/drawdown";
import { db } from "../lib/firebase";
import { ItemDoc, QuoteDoc, UserDoc, WatchlistDoc } from "../lib/models";
import { drawdownFor } from "../lib/quotes";
import { normalizeSymbol } from "../lib/symbols";
import { SymbolMatch } from "../providers";

/** Who is calling. `email` is set only when the account's email is verified. */
export interface McpCaller {
  uid: string;
  email: string | null;
}

/** External calls, injectable so tests do not hit the network. */
export interface McpDeps {
  /** Latest quote for a symbol, refreshed if stale. Null if the symbol is unknown. */
  getQuote(symbol: string): Promise<QuoteDoc | null>;
  search(query: string): Promise<SymbolMatch[]>;
}

const DEFAULT_THRESHOLDS = [10, 20, 30];
const MAX_ITEMS_PER_LIST = 200;

const thresholdsSchema = z
  .array(z.number().gt(0).lt(100))
  .max(10)
  .describe("Drawdown percentages that trigger an alert, e.g. [10, 20, 30] for -10%, -20%, -30%.");

class ToolError extends Error {}

export function buildMcpServer(caller: McpCaller, deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "drawdown-monitor", version: "1.0.0" },
    {
      instructions:
        "Drawdown Monitor tracks how far stocks, ETFs, indexes and crypto are below their all-time high (ATH). " +
        "Symbols use Yahoo Finance format: AAPL, ^GSPC (S&P 500), ^NDX, ^N225, BTC-USD. " +
        "Drawdown is a positive percentage below the ATH (0 = at the high). " +
        "Use search_symbols to find a symbol before adding it if unsure of the ticker.",
    },
  );

  // ------------------------------------------------------------- read tools

  server.registerTool(
    "list_watchlists",
    {
      title: "List watchlists",
      description: "List the user's own watchlists and the ones shared with them.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const own = await db.collection("watchlists").where("ownerId", "==", caller.uid).get();
        const shared = caller.email
          ? await db.collection("watchlists").where("sharedWith", "array-contains", caller.email).get()
          : null;
        const summarize = (d: FirebaseFirestore.QueryDocumentSnapshot, role: "owner" | "viewer") => {
          const w = d.data() as WatchlistDoc & { ownerName?: string };
          return { id: d.id, name: w.name, role, owner: role === "viewer" ? w.ownerName ?? null : undefined, isPublic: w.isPublic };
        };
        return {
          watchlists: [...own.docs.map((d) => summarize(d, "owner")), ...(shared?.docs ?? []).map((d) => summarize(d, "viewer"))],
        };
      }),
  );

  server.registerTool(
    "get_watchlist",
    {
      title: "Get watchlist drawdowns",
      description:
        "Get every symbol in a watchlist with its price, all-time high, current drawdown and alert thresholds, sorted by deepest drawdown first.",
      inputSchema: { watchlist_id: z.string().min(1).max(128) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ watchlist_id }) =>
      run(async () => {
        const { wl, role } = await loadWatchlist(watchlist_id, caller);
        const basis = await userBasis(caller.uid);
        const items = await db.collection(`watchlists/${watchlist_id}/items`).get();
        const symbols = items.docs.map((d) => d.id);
        const quoteSnaps = symbols.length ? await db.getAll(...symbols.map((s) => db.collection("quotes").doc(s))) : [];
        const quotes = new Map(quoteSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as QuoteDoc]));

        const rows = items.docs.map((d) => {
          const it = d.data() as ItemDoc;
          const q = quotes.get(d.id);
          return {
            symbol: d.id,
            ...describeQuote(q, basis),
            alertThresholds: it.thresholds ?? [],
            alertsEnabled: it.alertsEnabled,
            alertsTriggered: (it.thresholds ?? []).filter((t) => it.alertState?.[String(t).replace(".", "_")]),
          };
        });
        rows.sort((a, b) => (b.drawdownPct ?? -1) - (a.drawdownPct ?? -1));
        return { id: watchlist_id, name: wl.name, role, athBasis: basis, symbols: rows };
      }),
  );

  server.registerTool(
    "get_drawdown",
    {
      title: "Get drawdown for a symbol",
      description:
        "Current price, all-time high (closing and intraday, with dates) and drawdown for any symbol, whether or not it is in a watchlist.",
      inputSchema: { symbol: z.string().min(1).max(32).describe("Yahoo Finance symbol, e.g. ^GSPC, AAPL, BTC-USD") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ symbol }) =>
      run(async () => {
        const s = requireSymbol(symbol);
        const q = await deps.getQuote(s);
        if (!q) throw new ToolError(`No market data found for ${s}. Try search_symbols to find the right ticker.`);
        return {
          symbol: s,
          name: q.name,
          exchange: q.exchange,
          currency: q.currency,
          price: q.price,
          dayChangePct: q.changePct,
          marketOpen: q.sessionOpen,
          asOf: q.marketTime.toDate().toISOString(),
          closingAth: { value: q.athClose, date: isoDate(q.athCloseDate) },
          intradayAth: { value: q.athIntraday, date: isoDate(q.athIntradayDate) },
          drawdownFromClosingAthPct: q.drawdownClosePct,
          drawdownFromIntradayAthPct: q.drawdownIntradayPct,
        };
      }),
  );

  server.registerTool(
    "search_symbols",
    {
      title: "Search symbols",
      description: "Find ticker symbols by company, index or fund name (e.g. 'nikkei', 'apple', 'msci world').",
      inputSchema: { query: z.string().min(1).max(50) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ query }) => run(async () => ({ results: await deps.search(query) })),
  );

  // ------------------------------------------------------------ write tools

  server.registerTool(
    "create_watchlist",
    {
      title: "Create watchlist",
      description: "Create a new, private watchlist owned by the user.",
      inputSchema: { name: z.string().min(1).max(80) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ name }) =>
      run(async () => {
        const user = (await db.doc(`users/${caller.uid}`).get()).data() as UserDoc | undefined;
        const ref = db.collection("watchlists").doc();
        await ref.set({
          ownerId: caller.uid,
          ownerName: user?.displayName || user?.email || "Someone",
          name: name.trim(),
          isPublic: false,
          sharedWith: [],
          createdAt: FieldValue.serverTimestamp(),
        });
        return { id: ref.id, name: name.trim() };
      }),
  );

  server.registerTool(
    "add_symbol",
    {
      title: "Add symbol to watchlist",
      description: "Add a symbol to one of the user's own watchlists, with optional alert thresholds (default 10, 20, 30%).",
      inputSchema: {
        watchlist_id: z.string().min(1).max(128),
        symbol: z.string().min(1).max(32),
        thresholds: thresholdsSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ watchlist_id, symbol, thresholds }) =>
      run(async () => {
        await loadWatchlist(watchlist_id, caller, { mustOwn: true });
        const s = requireSymbol(symbol);
        const items = db.collection(`watchlists/${watchlist_id}/items`);
        if ((await items.doc(s).get()).exists) return { added: false, reason: `${s} is already in this watchlist.` };
        if ((await items.count().get()).data().count >= MAX_ITEMS_PER_LIST) {
          throw new ToolError(`A watchlist can hold at most ${MAX_ITEMS_PER_LIST} symbols.`);
        }
        const q = await deps.getQuote(s);
        if (!q) throw new ToolError(`No market data found for ${s}. Try search_symbols to find the right ticker.`);
        const t = normalizeThresholds(thresholds ?? DEFAULT_THRESHOLDS);
        await items.doc(s).set({
          symbol: s,
          ownerId: caller.uid,
          thresholds: t,
          alertsEnabled: true,
          alertState: {},
          addedAt: FieldValue.serverTimestamp(),
        });
        return { added: true, symbol: s, name: q.name, alertThresholds: t };
      }),
  );

  server.registerTool(
    "remove_symbol",
    {
      title: "Remove symbol from watchlist",
      description: "Remove a symbol from one of the user's own watchlists.",
      inputSchema: { watchlist_id: z.string().min(1).max(128), symbol: z.string().min(1).max(32) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ watchlist_id, symbol }) =>
      run(async () => {
        await loadWatchlist(watchlist_id, caller, { mustOwn: true });
        const s = requireSymbol(symbol);
        const ref = db.doc(`watchlists/${watchlist_id}/items/${s}`);
        if (!(await ref.get()).exists) return { removed: false, reason: `${s} is not in this watchlist.` };
        await ref.delete();
        return { removed: true, symbol: s };
      }),
  );

  server.registerTool(
    "set_alerts",
    {
      title: "Set alert thresholds",
      description:
        "Change the drawdown alert thresholds for a symbol in one of the user's watchlists, and/or turn its alerts on or off. Changing thresholds re-arms all of them.",
      inputSchema: {
        watchlist_id: z.string().min(1).max(128),
        symbol: z.string().min(1).max(32),
        thresholds: thresholdsSchema.optional(),
        enabled: z.boolean().optional().describe("Turn alerts for this symbol on or off."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ watchlist_id, symbol, thresholds, enabled }) =>
      run(async () => {
        await loadWatchlist(watchlist_id, caller, { mustOwn: true });
        const s = requireSymbol(symbol);
        if (thresholds === undefined && enabled === undefined) throw new ToolError("Provide thresholds and/or enabled.");
        const ref = db.doc(`watchlists/${watchlist_id}/items/${s}`);
        const snap = await ref.get();
        if (!snap.exists) throw new ToolError(`${s} is not in this watchlist.`);
        const patch: Record<string, unknown> = {};
        if (thresholds !== undefined) {
          patch.thresholds = normalizeThresholds(thresholds);
          patch.alertState = {};
        }
        if (enabled !== undefined) patch.alertsEnabled = enabled;
        await ref.update(patch);
        const it = { ...(snap.data() as ItemDoc), ...patch } as ItemDoc;
        return { symbol: s, alertThresholds: it.thresholds, alertsEnabled: it.alertsEnabled };
      }),
  );

  return server;
}

// ---------------------------------------------------------------- helpers

async function loadWatchlist(id: string, caller: McpCaller, opts: { mustOwn?: boolean } = {}) {
  const snap = await db.collection("watchlists").doc(id).get();
  const wl = snap.exists ? (snap.data() as WatchlistDoc) : null;
  const isOwner = wl?.ownerId === caller.uid;
  const canView = !!wl && (isOwner || wl.isPublic || (!!caller.email && wl.sharedWith.includes(caller.email)));
  if (!wl || !canView) throw new ToolError(`Watchlist ${id} not found. Use list_watchlists to see available IDs.`);
  if (opts.mustOwn && !isOwner) throw new ToolError("This watchlist is shared with you read-only; only its owner can change it.");
  return { wl, role: isOwner ? ("owner" as const) : ("viewer" as const) };
}

async function userBasis(uid: string): Promise<AthBasis> {
  const u = (await db.doc(`users/${uid}`).get()).data() as UserDoc | undefined;
  return u?.athBasis ?? "close";
}

function describeQuote(q: QuoteDoc | undefined, basis: AthBasis) {
  if (!q || q.price == null) return { name: null, price: null, ath: null, athDate: null, drawdownPct: null, note: q?.error ?? "no data yet" };
  return {
    name: q.name,
    price: q.price,
    currency: q.currency,
    dayChangePct: q.changePct,
    ath: basis === "intraday" ? q.athIntraday : q.athClose,
    athDate: isoDate(basis === "intraday" ? q.athIntradayDate : q.athCloseDate),
    drawdownPct: drawdownFor(q, basis),
    asOf: q.marketTime?.toDate().toISOString() ?? null,
  };
}

function requireSymbol(raw: string): string {
  const s = normalizeSymbol(raw);
  if (!s) throw new ToolError(`"${raw}" is not a valid symbol. Use Yahoo Finance format, e.g. AAPL, ^GSPC, BTC-USD.`);
  return s;
}

function normalizeThresholds(t: number[]): number[] {
  return [...new Set(t)].sort((a, b) => a - b);
}

function isoDate(ts: FirebaseFirestore.Timestamp | null | undefined): string | null {
  return ts ? ts.toDate().toISOString().slice(0, 10) : null;
}

/** Wrap a handler: JSON result as text + structured content; ToolErrors become tool-level errors. */
async function run(fn: () => Promise<Record<string, unknown>>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
    throw err;
  }
}
