import { FirebaseError } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  OAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  updateProfile,
  type AuthProvider,
} from "firebase/auth";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { auth } from "../lib/firebase";

type Mode = "signin" | "signup" | "reset";

const googleProvider = new GoogleAuthProvider();
const appleProvider = new OAuthProvider("apple.com");
appleProvider.addScope("email");
appleProvider.addScope("name");

export default function LoginPage() {
  const { user } = useAuth();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? "/";
  if (user) return <Navigate to={from} replace />;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (mode === "signin") return run(() => signInWithEmailAndPassword(auth, em, password));
    if (mode === "reset")
      return run(async () => {
        await sendPasswordResetEmail(auth, em);
        setInfo("If an account exists for that email, a reset link is on its way.");
      });
    return run(async () => {
      const cred = await createUserWithEmailAndPassword(auth, em, password);
      if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      await sendEmailVerification(cred.user);
    });
  }

  const social = (p: AuthProvider) =>
    run(async () => {
      try {
        await signInWithPopup(auth, p);
      } catch (e) {
        // Popups are often blocked on mobile Safari / in-app browsers.
        if (e instanceof FirebaseError && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) {
          await signInWithRedirect(auth, p);
          return;
        }
        throw e;
      }
    });

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1 className="brand">
          <span className="brand-mark">↘</span> Drawdown Monitor
        </h1>
        <p className="muted">Track how far your stocks and indexes are from their all-time highs.</p>

        {mode !== "reset" && (
          <>
            <button className="btn social google" disabled={busy} onClick={() => social(googleProvider)}>
              <GoogleIcon /> Continue with Google
            </button>
            <button className="btn social apple" disabled={busy} onClick={() => social(appleProvider)}>
              <AppleIcon /> Continue with Apple
            </button>
            <div className="divider">
              <span>or</span>
            </div>
          </>
        )}

        <form onSubmit={onSubmit} className="stack">
          {mode === "signup" && (
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          {mode !== "reset" && (
            <label>
              Password
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </label>
          )}
          {error && <div className="alert error">{error}</div>}
          {info && <div className="alert info">{info}</div>}
          <button className="btn primary" disabled={busy} type="submit">
            {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
          </button>
        </form>

        <div className="auth-links">
          {mode === "signin" ? (
            <>
              <button className="link" onClick={() => setMode("signup")}>Create an account</button>
              <button className="link" onClick={() => setMode("reset")}>Forgot password?</button>
            </>
          ) : (
            <button className="link" onClick={() => setMode("signin")}>Back to sign in</button>
          )}
        </div>
      </div>
    </div>
  );
}

function friendlyError(e: unknown): string {
  const code = e instanceof FirebaseError ? e.code : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password.";
    case "auth/email-already-in-use":
      return "An account already exists for this email. Try signing in instead.";
    case "auth/weak-password":
      return "Please choose a stronger password (at least 8 characters).";
    case "auth/account-exists-with-different-credential":
      return "This email is already linked to another sign-in method. Use that method instead.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    default:
      return e instanceof Error ? e.message : "Something went wrong.";
  }
}

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

const AppleIcon = () => (
  <svg width="16" height="18" viewBox="0 0 384 512" aria-hidden="true" fill="currentColor">
    <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
  </svg>
);
