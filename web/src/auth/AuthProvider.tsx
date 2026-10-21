import { onAuthStateChanged, reload, signOut, type User } from "firebase/auth";
import { doc } from "firebase/firestore";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useDocData } from "../hooks/firestore";
import { ensureUserProfile } from "../lib/api";
import { auth, db } from "../lib/firebase";
import type { UserProfile } from "../lib/types";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signOut: () => Promise<void>;
  /** Reload the user (e.g. after verifying email) and refresh the ID token. */
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [, force] = useState(0);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        if (u) await ensureUserProfile(u).catch((e) => console.error("profile init failed", e));
        setUser(u);
        setReady(true);
      }),
    [],
  );

  const profileState = useDocData<UserProfile>(user ? doc(db, "users", user.uid) : null, user?.uid ?? "");

  const refreshUser = useCallback(async () => {
    if (!auth.currentUser) return;
    await reload(auth.currentUser);
    await auth.currentUser.getIdToken(true);
    setUser(auth.currentUser);
    force((n) => n + 1);
  }, []);

  const value: AuthState = {
    user,
    profile: profileState.data,
    loading: !ready || (!!user && profileState.loading),
    signOut: () => signOut(auth),
    refreshUser,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
