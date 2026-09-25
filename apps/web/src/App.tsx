import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ApiError, useMe } from "./lib/api";
import { useAuth } from "./lib/auth";
import { BusinessLinePage } from "./pages/BusinessLinePage";
import { Overview } from "./pages/Overview";
import { PlatformPage } from "./pages/PlatformPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignIn } from "./pages/SignIn";
import { Status } from "./pages/Status";

/** Old per-platform links (/line/square) now live under Advanced. */
function LegacyLineRedirect() {
  const { line = "" } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/advanced/platform/${line}${search}`} replace />;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  return me.data.isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}

function Gate() {
  const { status } = useAuth();
  const me = useMe();
  if (status === "loading") return <div className="loading">Loading…</div>;
  if (status === "signed_out") return <SignIn />;
  if (me.error instanceof ApiError && me.error.status === 403) return <SignIn message={me.error.message} />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="bl/:id" element={<BusinessLinePage />} />
        <Route path="line/:line" element={<LegacyLineRedirect />} />
        <Route path="status" element={<Navigate to="/advanced/status" replace />} />
        <Route path="advanced/settings" element={<SettingsPage />} />
        <Route path="advanced/status" element={<AdminOnly><Status /></AdminOnly>} />
        <Route path="advanced/platform/:source" element={<AdminOnly><PlatformPage /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Gate />
    </BrowserRouter>
  );
}
