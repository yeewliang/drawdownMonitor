import { useState, type FormEvent } from "react";
import { shareWith, unshareWith, updateWatchlist } from "../lib/api";
import { isEmail } from "../lib/format";
import type { Watchlist } from "../lib/types";

export default function ShareDialog({ watchlist, onClose }: { watchlist: Watchlist; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/w/${watchlist.id}`;

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!isEmail(email)) return setError("Enter a valid email address.");
    if (watchlist.sharedWith.length >= 50) return setError("You can share with up to 50 people.");
    setError(null);
    await shareWith(watchlist.id, email);
    setEmail("");
  }

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share watchlist">
        <h3>Share “{watchlist.name}”</h3>

        <section className="stack">
          <h4>People</h4>
          <p className="muted small-text">They get read-only access after signing in with this email, and can copy the list to set their own alerts.</p>
          <form className="row" onSubmit={onAdd}>
            <input type="email" placeholder="friend@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn primary">Share</button>
          </form>
          {error && <div className="alert error">{error}</div>}
          <ul className="share-list">
            {watchlist.sharedWith.map((em) => (
              <li key={em}>
                <span>{em}</span>
                <button className="link danger" onClick={() => unshareWith(watchlist.id, em)}>Remove</button>
              </li>
            ))}
          </ul>
        </section>

        <section className="stack">
          <h4>Link sharing</h4>
          <label className="toggle">
            <input type="checkbox" checked={watchlist.isPublic} onChange={(e) => updateWatchlist(watchlist.id, { isPublic: e.target.checked })} />
            Anyone with the link can view (no sign-in needed)
          </label>
          {watchlist.isPublic && (
            <div className="row">
              <input readOnly value={link} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            </div>
          )}
        </section>

        <div className="row end">
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
