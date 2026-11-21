import { useEffect, useState, type FormEvent } from "react";
import { createApiKey, listApiKeys, listOAuthGrants, revokeApiKey, revokeOAuthGrant, type ApiKeyInfo, type OAuthGrantInfo } from "../lib/api";
import { CONNECTOR_URL, MCP_URL } from "../lib/firebase";

export default function McpAccess() {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [grants, setGrants] = useState<OAuthGrantInfo[] | null>(null);
  const reload = () => listApiKeys().then(setKeys, (e) => setError(String(e?.message ?? e)));
  const reloadGrants = () => listOAuthGrants().then(setGrants, (e) => setError(String(e?.message ?? e)));
  useEffect(() => {
    void reload();
    void reloadGrants();
  }, []);

  async function onDisconnect(g: OAuthGrantInfo) {
    if (!confirm(`Disconnect “${g.clientName}”? It will need to sign in again to use Drawdown Monitor.`)) return;
    await revokeOAuthGrant(g.id);
    await reloadGrants();
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { key } = await createApiKey(name || "MCP client");
      setNewKey(key);
      setName("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(k: ApiKeyInfo) {
    if (!confirm(`Revoke “${k.name}”? Clients using it will stop working.`)) return;
    await revokeApiKey(k.id);
    await reload();
  }

  const shownKey = newKey ?? "<YOUR_API_KEY>";
  const claudeCode = `claude mcp add --transport http drawdown-monitor ${MCP_URL} \\\n  --header "Authorization: Bearer ${shownKey}"`;
  const desktopJson = JSON.stringify(
    {
      mcpServers: {
        "drawdown-monitor": {
          command: "npx",
          args: ["-y", "mcp-remote", MCP_URL, "--header", "Authorization:${AUTH}"],
          env: { AUTH: `Bearer ${shownKey}` },
        },
      },
    },
    null,
    2,
  );

  return (
    <section className="card stack">
      <h3>MCP access</h3>
      <p className="muted">
        Let Claude and other AI assistants read your watchlists and drawdowns, look up any symbol, and add, remove or set alerts on symbols in
        your own lists. They act as you, so only create keys for clients you trust.
      </p>

      <h4>Claude on the web, mobile and desktop</h4>
      <ol className="steps">
        <li>In Claude, open <b>Settings &gt; Connectors</b> and choose <b>Add custom connector</b>.</li>
        <li>Name it <i>Drawdown Monitor</i> and paste this URL:<CopyField value={CONNECTOR_URL} /></li>
        <li>Click <b>Connect</b>, sign in here with the same account, and approve. It then works on every device signed in to your Claude account.</li>
      </ol>

      {grants && grants.length > 0 && (
        <>
          <h4>Connected apps</h4>
          <ul className="share-list">
            {grants.map((g) => (
              <li key={g.id}>
                <span>
                  <b>{g.clientName}</b>
                  <br />
                  <small className="muted">
                    Connected {new Date(g.createdAt).toLocaleDateString()} · {g.lastUsedAt ? `last active ${new Date(g.lastUsedAt).toLocaleDateString()}` : "not used yet"}
                  </small>
                </span>
                <button className="link danger" onClick={() => onDisconnect(g)}>Disconnect</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>API keys (Claude Code and other clients)</h4>
      <label>
        Server URL
        <CopyField value={MCP_URL} />
      </label>

      <form className="row" onSubmit={onCreate}>
        <input placeholder="Key name, e.g. Claude Code on laptop" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn primary" disabled={busy}>Create API key</button>
      </form>
      {error && <div className="alert error">{error}</div>}

      {newKey && (
        <div className="alert info stack">
          <b>Copy this key now. It will not be shown again.</b>
          <CopyField value={newKey} />
        </div>
      )}

      {keys && keys.length > 0 && (
        <ul className="share-list">
          {keys.map((k) => (
            <li key={k.id}>
              <span>
                <b>{k.name}</b> <code>{k.hint}…</code>
                <br />
                <small className="muted">
                  Created {new Date(k.createdAt).toLocaleDateString()} · {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "never used"}
                </small>
              </span>
              <button className="link danger" onClick={() => onRevoke(k)}>Revoke</button>
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>Connect Claude Code</summary>
        <pre className="code">{claudeCode}</pre>
      </details>
      <details>
        <summary>Connect Claude Desktop</summary>
        <p className="muted small-text">Add to claude_desktop_config.json (Settings &gt; Developer &gt; Edit config), then restart Claude Desktop. Requires Node.js.</p>
        <pre className="code">{desktopJson}</pre>
      </details>
    </section>
  );
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row">
      <input readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="btn"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
