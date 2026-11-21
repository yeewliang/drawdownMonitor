import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import Layout from "./components/Layout";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import OAuthAuthorizePage from "./pages/OAuthAuthorizePage";
import PortfolioPage from "./pages/PortfolioPage";
import SettingsPage from "./pages/SettingsPage";
import WatchlistPage from "./pages/WatchlistPage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="center muted">Loading…</div>;
  // Keep the query string: the OAuth consent page needs it after sign-in.
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

export default function App() {
  const { loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/oauth/authorize" element={<RequireAuth><OAuthAuthorizePage /></RequireAuth>} />
      <Route element={<Layout />}>
        <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
        <Route path="/portfolio" element={<RequireAuth><PortfolioPage /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
        {/* Public lists are viewable without signing in. */}
        <Route path="/w/:id" element={<WatchlistPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
