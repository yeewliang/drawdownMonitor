import { sendEmailVerification } from "firebase/auth";
import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export default function Layout() {
  const { user, signOut } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">↘</span> Drawdown Monitor
        </Link>
        <nav>
          {user ? (
            <>
              <NavLink to="/" end>Watchlists</NavLink>
              <NavLink to="/settings">Settings</NavLink>
              <button className="link" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <NavLink to="/login">Sign in</NavLink>
          )}
        </nav>
      </header>
      <VerifyBanner />
      <main className="content">
        <Outlet />
      </main>
      <footer className="footer muted">
        Prices from Yahoo Finance, refreshed every 5 minutes. US markets are real-time; some exchanges are delayed up to 15 minutes. Not investment advice.
      </footer>
    </div>
  );
}

/** Email/password users must verify before lists shared with their email become visible. */
function VerifyBanner() {
  const { user, refreshUser } = useAuth();
  const [sent, setSent] = useState(false);
  if (!user || user.emailVerified || !user.providerData.some((p) => p.providerId === "password")) return null;
  return (
    <div className="banner">
      Please verify <b>{user.email}</b> to see watchlists shared with you.{" "}
      {sent ? (
        <span>Verification email sent.</span>
      ) : (
        <button className="link" onClick={() => sendEmailVerification(user).then(() => setSent(true))}>Resend email</button>
      )}{" "}
      · <button className="link" onClick={refreshUser}>I've verified</button>
    </div>
  );
}
