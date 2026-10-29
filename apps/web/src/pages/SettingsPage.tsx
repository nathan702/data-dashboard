import { useEffect, useRef } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { SOURCE_INFO, SOURCES, UNASSIGNED, type Source } from "@dash/shared";
import { ProgramFamiliesCard } from "../components/ProgramFamilies";
import { SchoolsCard } from "../components/Schools";
import { SeasonSettingsCard } from "../components/SeasonSettings";
import { AssignmentsTab, isActive } from "../components/settings/AssignmentsTab";
import { useAssignments, useMe } from "../lib/api";

/** One platform's tab title: what its assignable things are called there. */
const PLATFORM_TAB: Record<Source, string> = {
  campminder: "Campminder sessions",
  square: "Square locations",
  shopify: "Shopify store",
  fareharbor: "FareHarbor dashboards",
  hubspot: "HubSpot pipelines",
};

const OTHER_TABS = [
  { id: "seasons", label: "Seasons" },
  { id: "program-families", label: "Program families" },
  { id: "schools", label: "Schools" },
] as const;

/**
 * Settings, one tab per topic (each with its own address, so it can be
 * bookmarked): a tab per connected platform for business-line assignments,
 * then seasons, program families and schools.
 */
export function SettingsPage() {
  const { tab } = useParams();
  const { data } = useAssignments();
  const me = useMe();
  const isAdmin = me.data?.isAdmin ?? false;
  const nav = useRef<HTMLElement>(null);
  // On a narrow screen the open tab may be scrolled out of sight.
  // (Braces matter: newer browsers return a promise from scrollIntoView, and an effect may only return a cleanup function.)
  useEffect(() => {
    nav.current?.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, data]);

  // A platform gets a tab once it has something to assign.
  const platforms = SOURCES.filter((s) => data?.rows.some((r) => r.source === s));
  const needsAttention = (s: Source) => data?.rows.filter((r) => r.source === s && r.businessLine === UNASSIGNED && isActive(r)).length ?? 0;
  const notYet = SOURCES.filter((s) => data && !platforms.includes(s)).map((s) => SOURCE_INFO[s].label);
  const tabs = [...platforms.map((s) => ({ id: s as string, label: PLATFORM_TAB[s], badge: needsAttention(s) })), ...OTHER_TABS.map((t) => ({ ...t, badge: 0 }))];

  // Plain "Settings" links open the first platform with something unassigned (e.g. from the Overview).
  if (!tab && data) return <Navigate to={`/advanced/settings/${platforms.find((p) => needsAttention(p) > 0) ?? platforms[0] ?? "seasons"}`} replace />;
  if (!tab) return null;
  const known = tabs.some((t) => t.id === tab);
  // Platform tabs appear once their rows load; don't bounce away before then.
  if (data && !known) return <Navigate to="/advanced/settings" replace />;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      {me.data?.adminsUnconfigured && (
        <div className="notice">
          Everyone who can sign in can change these settings, because no admins are listed yet. To limit it, add an <code>admins</code> list
          to the <code>config/access</code> document in Firestore (see docs/SETUP.md).
        </div>
      )}
      {me.data && !isAdmin && <div className="notice">Only dashboard admins can change these. Ask an admin if something is set wrong.</div>}
      <nav className="settings-tabs" aria-label="Settings sections" ref={nav}>
        {tabs.map((t) => (
          <NavLink key={t.id} to={`/advanced/settings/${t.id}`}>
            {t.label}
            {t.badge > 0 && (
              <span className="tab-badge" title={`${t.badge} need attention`}>
                {t.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      {(SOURCES as readonly string[]).includes(tab) && known && <AssignmentsTab source={tab as Source} />}
      {tab === "seasons" && <SeasonSettingsCard canEdit={isAdmin} />}
      {tab === "program-families" && <ProgramFamiliesCard canEdit={isAdmin} />}
      {tab === "schools" && <SchoolsCard canEdit={isAdmin} />}
      {notYet.length > 0 && (SOURCES as readonly string[]).includes(tab) && (
        <p className="phase-note">{new Intl.ListFormat("en", { type: "conjunction" }).format(notYet)} get a tab here once connected.</p>
      )}
    </div>
  );
}
