import { useEffect, useState } from "react";
import { SOURCE_INFO, type Source, type SourceFreshness } from "@dash/shared";
import { useFreshness } from "../lib/api";
import { timeAgo } from "../lib/format";

/** How long before a source counts as stale, by how it syncs. */
const STALE_AFTER_MINUTES: Record<Source, number> = {
  shopify: 30,
  square: 30,
  hubspot: 30,
  fareharbor: 120,
  campminder: 180,
};

export type Health = "good" | "warning" | "critical" | "pending";

export function health(f: SourceFreshness, now = Date.now()): Health {
  if (f.status === "never_run" && !f.lastDataAt) return "pending";
  if (f.status === "error") return "critical";
  // Whichever is newer: a webhook landing counts as fresh even between full syncs.
  const last = Math.max(f.lastSuccessAt ? Date.parse(f.lastSuccessAt) : 0, f.lastDataAt ? Date.parse(f.lastDataAt) : 0);
  if (!last) return "pending";
  return now - last > STALE_AFTER_MINUTES[f.source] * 60_000 ? "warning" : "good";
}

const HEALTH_LABEL: Record<Health, string> = { good: "Up to date", warning: "Stale", critical: "Sync failing", pending: "Not connected" };
const HEALTH_ICON: Record<Health, string> = { good: "●", warning: "▲", critical: "✕", pending: "○" };

export function HealthBadge({ h }: { h: Health }) {
  return (
    <span className={`health health-${h}`}>
      <span aria-hidden>{HEALTH_ICON[h]}</span> {HEALTH_LABEL[h]}
    </span>
  );
}

function useNow(intervalMs = 10_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** "Updated 12s ago" for one source (or the stalest of several). */
export function FreshnessNote({ sources }: { sources: Source[] }) {
  const { data } = useFreshness();
  const now = useNow();
  if (!data) return null;
  const relevant = data.sources.filter((s) => sources.includes(s.source));
  if (relevant.length === 0) return null;
  const parts = relevant.map((s) => `${SOURCE_INFO[s.source].label} ${timeAgo(s.lastDataAt, now)}`);
  return <p className="freshness-note">Data updated: {parts.join(" · ")}</p>;
}

export { useNow };
