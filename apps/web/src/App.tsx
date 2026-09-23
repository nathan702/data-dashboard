import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ApiError, useMe } from "./lib/api";
import { useAuth } from "./lib/auth";
import { BusinessLinePage } from "./pages/BusinessLinePage";
import { Overview } from "./pages/Overview";
import { SignIn } from "./pages/SignIn";
import { Status } from "./pages/Status";

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
        <Route path="line/:line" element={<BusinessLinePage />} />
        <Route path="status" element={<Status />} />
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
