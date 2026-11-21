import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { OAUTH_FN_URL } from "../lib/firebase";

/**
 * OAuth consent page (/oauth/authorize). An MCP client such as Claude sends
 * the user here; once signed in they approve or cancel, and the server
 * returns the client's registered redirect URL to continue to. The page
 * never redirects to an address the server has not validated.
 */
export default function OAuthAuthorizePage() {
  const { user, signOut } = useAuth();
  const { search } = useLocation();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const [client, setClient] = useState<{ client_name: string; redirect_host: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const paramError =
    params.response_type !== "code"
      ? "This sign-in link is not valid (response_type must be code)."
      : !params.client_id || !params.redirect_uri
        ? "This sign-in link is missing the app's details."
        : null;

  useEffect(() => {
    if (paramError) return;
    const q = new URLSearchParams({ client_id: params.client_id, redirect_uri: params.redirect_uri });
    fetch(`${OAUTH_FN_URL}/oauth/client?${q}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error_description ?? "This app is not recognised.");
        setClient(body);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [params, paramError]);

  async function decide(allow: boolean) {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${OAUTH_FN_URL}/oauth/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` },
        body: JSON.stringify({
          client_id: params.client_id,
          redirect_uri: params.redirect_uri,
          code_challenge: params.code_challenge,
          code_challenge_method: params.code_challenge_method,
          state: params.state,
          scope: params.scope,
          resource: params.resource,
          deny: !allow,
        }),
      });
      const body = await r.json();
      if (!r.ok || typeof body.redirect !== "string") throw new Error(body.error_description ?? "Something went wrong. Try again.");
      window.location.assign(body.redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1 className="brand">
          <span className="brand-mark">↘</span> Drawdown Monitor
        </h1>

        {paramError || (error && !client) ? (
          <div className="alert error">{paramError ?? error}</div>
        ) : !client ? (
          <p className="muted">Checking the app…</p>
        ) : (
          <>
            <p>
              <b>{client.client_name}</b> wants to access your Drawdown Monitor account.
            </p>
            <ul className="consent-list">
              <li>Read your watchlists, portfolio and alert settings</li>
              <li>Add or remove symbols and change alerts in your own lists</li>
              <li>Save your brokerage portfolio snapshots</li>
            </ul>
            <p className="muted small-text">
              Signed in as <b>{user?.email}</b>. After you allow, you'll return to <b>{client.redirect_host}</b>. You can disconnect any time in
              Settings &gt; MCP access.
            </p>
            {error && <div className="alert error">{error}</div>}
            <div className="row consent-actions">
              <button className="btn" disabled={busy} onClick={() => decide(false)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={() => decide(true)}>{busy ? "Continuing…" : "Allow"}</button>
            </div>
            <button className="link small-text" onClick={() => void signOut()}>Not you? Sign out</button>
          </>
        )}
      </div>
    </div>
  );
}
