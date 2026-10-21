import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import McpAccess from "../components/McpAccess";
import { createTelegramLink, sendTestAlert, unlinkTelegram, updateUserProfile } from "../lib/api";
import { TELEGRAM_BOT_USERNAME } from "../lib/firebase";
import { isEmail } from "../lib/format";

export default function SettingsPage() {
  const { user, profile } = useAuth();
  const uid = user!.uid;
  const [alertEmail, setAlertEmail] = useState(profile?.alertEmail ?? "");
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const linked = !!profile?.telegramChatId;

  async function saveAlertEmail() {
    const v = alertEmail.trim().toLowerCase();
    if (v && !isEmail(v)) return setEmailMsg("Enter a valid email address.");
    await updateUserProfile(uid, { alertEmail: v || null });
    setEmailMsg("Saved.");
  }

  async function connectTelegram() {
    // Open the window synchronously so popup blockers allow it, then point it at the deep link.
    const win = window.open("", "_blank");
    const url = await createTelegramLink(uid, TELEGRAM_BOT_USERNAME);
    if (win) win.location.href = url;
    else window.location.href = url;
  }

  async function test() {
    setBusy(true);
    setTestMsg(null);
    try {
      const r = await sendTestAlert();
      setTestMsg(`Email: ${r.email}, Telegram: ${r.telegram}`);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : "Failed to send test alert.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg narrow">
      <h2>Settings</h2>

      <section className="card stack">
        <h3>Drawdown basis</h3>
        <p className="muted">Which all-time high to measure drawdown from. Indexes are usually quoted against the record close.</p>
        <label className="radio">
          <input type="radio" checked={(profile?.athBasis ?? "close") === "close"} onChange={() => updateUserProfile(uid, { athBasis: "close" })} />
          Closing ATH (highest daily close)
        </label>
        <label className="radio">
          <input type="radio" checked={profile?.athBasis === "intraday"} onChange={() => updateUserProfile(uid, { athBasis: "intraday" })} />
          Intraday ATH (highest traded price)
        </label>
      </section>

      <section className="card stack">
        <h3>Email alerts</h3>
        <label className="toggle">
          <input type="checkbox" checked={profile?.notifyEmail !== false} onChange={(e) => updateUserProfile(uid, { notifyEmail: e.target.checked })} />
          Send alerts by email
        </label>
        <label>
          Send to (leave blank to use {user?.email ?? "your account email"})
          <div className="row">
            <input type="email" value={alertEmail} onChange={(e) => { setAlertEmail(e.target.value); setEmailMsg(null); }} placeholder={user?.email ?? ""} />
            <button className="btn" onClick={saveAlertEmail}>Save</button>
          </div>
        </label>
        {emailMsg && <div className="muted small-text">{emailMsg}</div>}
      </section>

      <section className="card stack">
        <h3>Telegram alerts</h3>
        {linked ? (
          <>
            <p>
              Connected{profile?.telegramUsername ? <> as <b>@{profile.telegramUsername}</b></> : null}. Send <code>/status</code> to the bot any time for current drawdowns.
            </p>
            <label className="toggle">
              <input type="checkbox" checked={profile?.notifyTelegram !== false} onChange={(e) => updateUserProfile(uid, { notifyTelegram: e.target.checked })} />
              Send alerts on Telegram
            </label>
            <div>
              <button className="btn danger" onClick={() => unlinkTelegram()}>Disconnect Telegram</button>
            </div>
          </>
        ) : TELEGRAM_BOT_USERNAME ? (
          <>
            <p className="muted">Opens Telegram and links the chat to your account when you press <b>Start</b>.</p>
            <div>
              <button className="btn primary" onClick={connectTelegram}>Connect Telegram</button>
            </div>
          </>
        ) : (
          <p className="muted">Telegram is not configured for this deployment (set VITE_TELEGRAM_BOT_USERNAME).</p>
        )}
      </section>

      <McpAccess />

      <section className="card stack">
        <h3>Test</h3>
        <p className="muted">Send a sample alert to every enabled channel.</p>
        <div>
          <button className="btn" disabled={busy} onClick={test}>{busy ? "Sending…" : "Send test alert"}</button>
        </div>
        {testMsg && <div className="muted small-text">{testMsg}</div>}
      </section>
    </div>
  );
}
