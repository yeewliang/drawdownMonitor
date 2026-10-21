import { collection, query, where } from "firebase/firestore";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useQueryData } from "../hooks/firestore";
import { createWatchlist } from "../lib/api";
import { db } from "../lib/firebase";
import type { Watchlist } from "../lib/types";

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const uid = user!.uid;
  const email = user!.emailVerified ? user!.email?.toLowerCase() ?? null : null;

  const mine = useQueryData<Watchlist>(query(collection(db, "watchlists"), where("ownerId", "==", uid)), `mine:${uid}`);
  const shared = useQueryData<Watchlist>(
    email ? query(collection(db, "watchlists"), where("sharedWith", "array-contains", email)) : null,
    `shared:${email}`,
  );

  const byCreated = (a: Watchlist, b: Watchlist) => (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const id = await createWatchlist(user!, name || "My watchlist");
      setName("");
      navigate(`/w/${id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <section>
        <div className="section-head">
          <h2>My watchlists</h2>
        </div>
        <form className="row" onSubmit={onCreate}>
          <input placeholder="New watchlist name, e.g. US indexes" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <button className="btn primary" disabled={busy}>Create</button>
        </form>
        {mine.loading ? (
          <p className="muted">Loading…</p>
        ) : mine.data.length === 0 ? (
          <div className="empty">
            <p>No watchlists yet.</p>
            <p className="muted">Create one above, then add symbols like <code>^GSPC</code>, <code>^IXIC</code>, <code>AAPL</code> or <code>BTC-USD</code>.</p>
          </div>
        ) : (
          <ul className="list-cards">
            {[...mine.data].sort(byCreated).map((w) => (
              <ListCard key={w.id} w={w} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Shared with me</h2>
        {!email ? (
          <p className="muted">Verify your email address to see watchlists others have shared with you.</p>
        ) : shared.data.length === 0 ? (
          <p className="muted">Nothing shared with {email} yet.</p>
        ) : (
          <ul className="list-cards">
            {[...shared.data].sort(byCreated).map((w) => (
              <ListCard key={w.id} w={w} showOwner />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ListCard({ w, showOwner }: { w: Watchlist; showOwner?: boolean }) {
  return (
    <li>
      <Link to={`/w/${w.id}`} className="card list-card">
        <div className="list-card-name">{w.name}</div>
        <div className="badges">
          {showOwner && <span className="badge">by {w.ownerName ?? "someone"}</span>}
          {w.isPublic && <span className="badge public">Public link</span>}
          {!showOwner && w.sharedWith.length > 0 && <span className="badge">Shared with {w.sharedWith.length}</span>}
        </div>
      </Link>
    </li>
  );
}
