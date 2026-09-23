import { NavLink, Outlet } from "react-router-dom";
import { BUSINESS_LINE_INFO, BUSINESS_LINES } from "@dash/shared";
import { useAuth } from "../lib/auth";
import { LINE_COLOR_VAR } from "../lib/colors";

export function Layout() {
  const { user, signOut } = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Business Dashboard</div>
        <nav className="nav" aria-label="Sections">
          <NavLink to="/" end>
            Overview
          </NavLink>
          {BUSINESS_LINES.map((l) => (
            <NavLink key={l} to={`/line/${l}`}>
              <span className="swatch" style={{ background: LINE_COLOR_VAR[l] }} aria-hidden />
              {BUSINESS_LINE_INFO[l].label}
            </NavLink>
          ))}
          <NavLink to="/status">Status</NavLink>
        </nav>
        <div className="user">
          <span className="muted user-email">{user?.email}</span>
          <button type="button" className="button button-ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
