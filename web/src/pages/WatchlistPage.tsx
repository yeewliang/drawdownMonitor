import { collection, doc } from "firebase/firestore";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import ShareDialog from "../components/ShareDialog";
import SymbolSearch from "../components/SymbolSearch";
import ThresholdEditor from "../components/ThresholdEditor";
import { useDocData, useQueryData, useQuotes } from "../hooks/firestore";
import { addItem, copyWatchlist, deleteWatchlist, removeItem, updateItem, updateUserProfile, updateWatchlist } from "../lib/api";
import { db } from "../lib/firebase";
import { athOf, drawdownOf, fmtAgo, fmtDate, fmtPct, fmtPrice, severity, summaryTime } from "../lib/format";
import type { AthBasis, Quote, WatchItem, Watchlist } from "../lib/types";

type SortKey = "symbol" | "drawdown" | "change";

export default function WatchlistPage() {
  const { id = "" } = useParams();
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const wl = useDocData<Watchlist>(doc(db, "watchlists", id), `wl:${id}:${user?.uid}`);
  const items = useQueryData<WatchItem>(wl.data ? collection(db, "watchlists", id, "items") : null, `items:${id}:${!!wl.data}:${user?.uid}`);
  const symbols = useMemo(() => items.data.map((i) => i.symbol), [items.data]);
  const quotes = useQuotes(symbols);

  const [localBasis, setLocalBasis] = useState<AthBasis>("close");
  const basis: AthBasis = profile?.athBasis ?? localBasis;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "drawdown", dir: -1 });
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const isOwner = !!user && wl.data?.ownerId === user.uid;

  const rows = useMemo(() => {
    const r = items.data.map((it) => ({ it, q: quotes[it.symbol] as Quote | undefined, dd: drawdownOf(quotes[it.symbol], basis) }));
    const val = (x: (typeof r)[number]) =>
      sort.key === "symbol" ? x.it.symbol : sort.key === "change" ? x.q?.changePct ?? -Infinity : x.dd ?? -Infinity;
    return r.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [items.data, quotes, basis, sort]);

  if (wl.loading) return <p className="muted">Loading…</p>;
  if (!wl.data) {
    return (
      <div className="empty">
        <p>This watchlist does not exist or you do not have access to it.</p>
        {!user && <p><Link to="/login" state={{ from: `/w/${id}` }}>Sign in</Link> if it was shared with you.</p>}
      </div>
    );
  }
  const w = wl.data;

  const setBasis = (b: AthBasis) => (user ? updateUserProfile(user.uid, { athBasis: b }) : setLocalBasis(b));
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "symbol" ? 1 : -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  async function onDelete() {
    if (!confirm(`Delete “${w.name}”? This cannot be undone.`)) return;
    await deleteWatchlist(w.id);
    navigate("/");
  }

  async function onCopy() {
    const newId = await copyWatchlist(user!, w);
    navigate(`/w/${newId}`);
  }

  async function saveName() {
    const n = renaming?.trim();
    if (n && n !== w.name) await updateWatchlist(w.id, { name: n.slice(0, 80) });
    setRenaming(null);
  }

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          {renaming != null ? (
            <input
              className="title-input"
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              maxLength={80}
            />
          ) : (
            <h2 onClick={isOwner ? () => setRenaming(w.name) : undefined} className={isOwner ? "editable" : ""} title={isOwner ? "Click to rename" : undefined}>
              {w.name}
            </h2>
          )}
          <div className="badges">
            {!isOwner && <span className="badge">by {w.ownerName ?? "someone"} · read-only</span>}
            {w.isPublic && <span className="badge public">Public link</span>}
            {isOwner && w.sharedWith.length > 0 && <span className="badge">Shared with {w.sharedWith.length}</span>}
          </div>
        </div>
        <div className="row">
          <div className="segmented" role="group" aria-label="ATH basis">
            <button className={basis === "close" ? "active" : ""} onClick={() => setBasis("close")} title="Drawdown from the highest daily close">Closing ATH</button>
            <button className={basis === "intraday" ? "active" : ""} onClick={() => setBasis("intraday")} title="Drawdown from the highest intraday price">Intraday ATH</button>
          </div>
          {isOwner && (
            <label className="toggle" title={profile?.telegramChatId ? `Telegram message every day at ${summaryTime(profile)} (change in Settings)` : "Connect Telegram in Settings first"}>
              <input type="checkbox" checked={!!w.dailySummary} onChange={(e) => updateWatchlist(w.id, { dailySummary: e.target.checked })} />
              Daily Telegram summary
            </label>
          )}
          {isOwner && <button className="btn" onClick={() => setRenaming(w.name)}>Rename</button>}
          {isOwner && <button className="btn" onClick={() => setSharing(true)}>Share</button>}
          {isOwner && <button className="btn danger" onClick={onDelete}>Delete</button>}
          {!isOwner && user && <button className="btn primary" onClick={onCopy}>Copy to my watchlists</button>}
          {!user && <Link className="btn primary" to="/login" state={{ from: `/w/${id}` }}>Sign in to copy</Link>}
        </div>
      </div>

      {isOwner && <SymbolSearch existing={new Set(symbols)} onAdd={(s) => addItem(w.id, user!.uid, s)} />}

      {items.loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>No symbols yet.</p>
          {isOwner && <p className="muted">Try <code>^GSPC</code> (S&amp;P 500), <code>^NDX</code> (Nasdaq 100), <code>^STI</code>, <code>AAPL</code>, <code>BTC-USD</code>.</p>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort("symbol")}>Symbol{arrow("symbol")}</th>
                <th className="num">Price</th>
                <th className="num sortable hide-sm" onClick={() => toggleSort("change")}>Day{arrow("change")}</th>
                <th className="num hide-sm">{basis === "close" ? "Closing" : "Intraday"} ATH</th>
                <th className="sortable" onClick={() => toggleSort("drawdown")}>Drawdown{arrow("drawdown")}</th>
                <th>Alerts at</th>
                <th className="hide-sm">Updated</th>
                {isOwner && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ it, q, dd }) => (
                <Row key={it.id} item={it} quote={q} dd={dd} basis={basis} watchlistId={w.id} isOwner={isOwner} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sharing && <ShareDialog watchlist={w} onClose={() => setSharing(false)} />}
    </div>
  );
}

function Row({ item, quote, dd, basis, watchlistId, isOwner }: { item: WatchItem; quote?: Quote; dd: number | null; basis: AthBasis; watchlistId: string; isOwner: boolean }) {
  const ath = athOf(quote, basis);
  const pending = !quote || (quote.price == null && !quote.error);
  const sev = severity(dd);

  return (
    <tr>
      <td>
        <div className="sym">{item.symbol}</div>
        <div className="muted small-text truncate">{quote?.name ?? (pending ? "Fetching…" : "")}</div>
      </td>
      {quote?.error && quote.price == null ? (
        <td colSpan={4} className="error-text">Symbol not found or no data: {quote.error}</td>
      ) : (
        <>
          <td className="num">
            {fmtPrice(quote?.price)} <span className="hide-sm">{quote?.currency}</span>
          </td>
          <td className={`num hide-sm ${quote?.changePct == null ? "" : quote.changePct >= 0 ? "up" : "down"}`}>{fmtPct(quote?.changePct, true)}</td>
          <td className="num hide-sm">
            {fmtPrice(ath.value)}
            <div className="muted small-text">{fmtDate(ath.date)}</div>
          </td>
          <td>
            <div className={`dd dd-${sev}`}>
              <span className="dd-value">{dd == null ? "–" : dd === 0 ? "At ATH" : `-${fmtPct(dd)}`}</span>
              <span className="dd-bar">
                <span style={{ width: `${Math.min(100, (dd ?? 0) * 2)}%` }} />
              </span>
            </div>
          </td>
        </>
      )}
      <td>
        <div className="row tight">
          {isOwner && (
            <input
              type="checkbox"
              checked={item.alertsEnabled}
              onChange={(e) => updateItem(watchlistId, item.symbol, { alertsEnabled: e.target.checked })}
              title={item.alertsEnabled ? "Alerts on" : "Alerts off"}
              aria-label={`Alerts for ${item.symbol}`}
            />
          )}
          <span className={item.alertsEnabled ? "" : "disabled"}>
            <ThresholdEditor
              thresholds={item.thresholds ?? []}
              alertState={item.alertState}
              editable={isOwner}
              onSave={(t) => updateItem(watchlistId, item.symbol, { thresholds: t })}
            />
          </span>
        </div>
      </td>
      <td className="muted small-text hide-sm" title={quote?.marketTime?.toDate().toLocaleString()}>
        {fmtAgo(quote?.marketTime)}
        {quote?.sessionOpen && <span className="live" title="Market open"> ●</span>}
      </td>
      {isOwner && (
        <td>
          <button className="link danger" onClick={() => removeItem(watchlistId, item.symbol)} aria-label={`Remove ${item.symbol}`}>✕</button>
        </td>
      )}
    </tr>
  );
}
