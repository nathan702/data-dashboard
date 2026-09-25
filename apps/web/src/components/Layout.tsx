import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { BUSINESS_LINE_INFO, SOURCE_INFO, SOURCES } from "@dash/shared";
import { useMe } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTabs } from "../lib/tabs";
import { CustomizeTabs } from "./CustomizeTabs";

/** Admin-only menu: per-platform pages, data status and Settings. */
function AdvancedMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className={`nav-button${pathname.startsWith("/advanced") ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        Advanced ▾
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          <NavLink role="menuitem" to="/advanced/settings">Settings</NavLink>
          <NavLink role="menuitem" to="/advanced/status">Data status</NavLink>
          <div className="menu-heading">Platforms (all business lines)</div>
          {SOURCES.map((s) => (
            <NavLink role="menuitem" key={s} to={`/advanced/platform/${s}`}>
              {SOURCE_INFO[s].label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, signOut } = useAuth();
  const me = useMe();
  const tabs = useTabs();
  const { search } = useLocation();
  const [customizing, setCustomizing] = useState(false);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Business Dashboard</div>
        <nav className="nav" aria-label="Business lines">
          {/* Carry the date filters between pages. */}
          <NavLink to={`/${search}`} end>
            Overview
          </NavLink>
          {tabs.map((id) => (
            <NavLink key={id} to={`/bl/${id}${search}`}>
              {BUSINESS_LINE_INFO[id].label}
            </NavLink>
          ))}
          <button type="button" className="nav-button" onClick={() => setCustomizing(true)} title="Choose and order your tabs">
            ⚙ Tabs
          </button>
          {me.data?.isAdmin && <AdvancedMenu />}
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
      {customizing && <CustomizeTabs tabs={tabs} onClose={() => setCustomizing(false)} />}
    </div>
  );
}
