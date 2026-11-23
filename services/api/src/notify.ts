import {
  addDays,
  alertWanted,
  BUSINESS_LINE_INFO,
  BUSINESS_LINES,
  bigDayAlerts,
  CALENDAR_YEAR,
  digestDue,
  digestSlackText,
  easternMoment,
  staleSources,
  syncAlerts,
  targetAlerts,
  type Alert,
  type AlertState,
  type BusinessLine,
  type DigestContent,
  type IsoDate,
  type RevenueSummaryResponse,
} from "@dash/shared";
import type { AlertStateStore, NotificationStore } from "./notifications.js";
import type { SeasonSettingsStore } from "./seasons.js";
import type { Messenger, SendResult } from "./slack.js";
import { createTargetProgress } from "./targetProgress.js";
import type { TargetStore } from "./targets.js";
import type { FreshnessSource, Warehouse } from "./warehouse/types.js";

export interface NotifyDeps {
  warehouse: Warehouse;
  freshness: FreshnessSource;
  seasons: SeasonSettingsStore;
  targets: TargetStore;
  notifications: NotificationStore;
  alertState: AlertStateStore;
  messenger: Messenger;
  /** The dashboard's address, linked from every message. */
  appUrl: string;
  now?: () => Date;
}

export type DigestDeps = Pick<NotifyDeps, "warehouse" | "freshness" | "seasons" | "targets" | "appUrl" | "now">;

/** The period a digest covers: yesterday, or last Monday–Sunday. */
export function digestPeriod(kind: "daily" | "weekly", today: IsoDate): { start: IsoDate; end: IsoDate } {
  if (kind === "daily") return { start: addDays(today, -1), end: addDays(today, -1) };
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  return { start: addDays(monday, -7), end: addDays(monday, -1) };
}

/** Everything a digest says, for every line (each person then sees their own lines). */
export async function buildDigest(deps: DigestDeps, kind: "daily" | "weekly", today: IsoDate): Promise<DigestContent> {
  const period = digestPeriod(kind, today);
  const summary = (compare: "previous_year" | "previous_year_weekday") =>
    deps.warehouse.revenueSummary(
      { ...period, basis: "booked", measure: "net", granularity: "day", compare, groupBy: "business_line" },
      CALENDAR_YEAR,
    );
  const progress = createTargetProgress(deps);
  const [byDate, byWeekday, signups, targets, freshness] = await Promise.all([
    summary("previous_year"),
    summary("previous_year_weekday"),
    deps.warehouse.signupCounts(period.start, period.end),
    Promise.all(BUSINESS_LINES.map((l) => progress(l))),
    deps.freshness.freshness(),
  ]);
  const group = (r: RevenueSummaryResponse, line: BusinessLine) => r.groups.find((g) => g.key === line);
  const rows = BUSINESS_LINES.map((line) => {
    const g = group(BUSINESS_LINE_INFO[line].weekdayComparison ? byWeekday : byDate, line);
    const s = signups.find((x) => x.businessLine === line);
    return {
      line,
      revenue: Math.round((g?.current.net ?? 0) * 100) / 100,
      previous: g?.comparison ? Math.round(g.comparison.net * 100) / 100 : null,
      signups: BUSINESS_LINE_INFO[line].sources.includes("campminder") ? { enrollments: s?.enrollments ?? 0, campers: s?.campers ?? 0 } : null,
    };
  });
  return {
    kind,
    period,
    rows,
    targets: targets.filter((t) => t.rows.length > 0),
    stale: staleSources(freshness, deps.now?.() ?? new Date()),
    url: deps.appUrl,
  };
}

export interface NotifyRunSummary {
  hour: number;
  date: IsoDate;
  subscribers: number;
  alerts: string[];
  results: Partial<Record<SendResult, number>>;
}

/**
 * One hourly run: work out which alerts fired since last time (and remember
 * them so each fires once), then send each person their due digest and the
 * alerts they chose, as one Slack message.
 */
export async function runNotifications(deps: NotifyDeps): Promise<NotifyRunSummary> {
  const now = deps.now?.() ?? new Date();
  const m = easternMoment(now);
  const yesterday = addDays(m.date, -1);
  const [subs, prev, freshness] = await Promise.all([deps.notifications.subscribers(), deps.alertState.get(), deps.freshness.freshness()]);
  const progress = createTargetProgress(deps);
  const alerts: Alert[] = [];
  const next: AlertState = { ...prev };

  // Targets turning behind (or recovering).
  const lines = await Promise.all(BUSINESS_LINES.map((l) => progress(l)));
  const t = targetAlerts(prev.targets, lines);
  alerts.push(...t.alerts);
  next.targets = t.next;

  // Platforms that stopped syncing (only connected ones).
  const connected = freshness.filter((f) => f.status !== "never_run").map((f) => f.source);
  const s = syncAlerts(prev.stale, staleSources(freshness, now), connected);
  alerts.push(...s.alerts);
  next.stale = s.next;

  // Revenue not assigned to a line, booked in the last 7 days.
  const unassigned = await deps.warehouse.revenueSummary(
    { start: addDays(m.date, -7), end: m.date, basis: "booked", measure: "gross", granularity: "day", compare: "none", groupBy: "business_line", businessLines: ["unassigned"] },
    CALENDAR_YEAR,
  );
  const hasUnassigned = unassigned.groups.some((g) => g.key === "unassigned" && Math.abs(g.current.gross) > 0.005);
  if (hasUnassigned && !prev.unassigned) {
    alerts.push({ kind: "unassigned", line: null, text: "⚠️ Revenue booked in the last week isn't assigned to a business line. Settings shows what's unassigned." });
  }
  next.unassigned = hasUnassigned;

  // Digests due this hour, built once per kind.
  const built = new Map<"daily" | "weekly", Promise<DigestContent>>();
  const digest = (kind: "daily" | "weekly") => {
    if (!built.has(kind)) built.set(kind, buildDigest(deps, kind, m.date));
    return built.get(kind)!;
  };

  // Big days: yesterday against the same day last year, once a day from 7am.
  if (m.hour >= 7 && prev.bigDayFor !== yesterday) {
    alerts.push(...bigDayAlerts((await digest("daily")).rows, yesterday));
    next.bigDayFor = yesterday;
  }

  const results: NotifyRunSummary["results"] = {};
  for (const sub of subs) {
    const lines = sub.settings.lines ?? sub.tabs;
    const parts: string[] = [];
    const due = digestDue(sub.settings, m);
    if (due) parts.push(digestSlackText(await digest(due), lines));
    const mine = alerts.filter((a) => alertWanted(a, sub.settings, lines));
    if (mine.length) parts.push([due ? "*Alerts*" : null, ...mine.map((a) => a.text)].filter(Boolean).join("\n"));
    if (!parts.length) continue;
    // Email arrives in the next update; Slack direct messages now.
    if (sub.settings.slack) {
      const r = await deps.messenger.slack(sub.email, parts.join("\n\n"));
      results[r] = (results[r] ?? 0) + 1;
    }
  }
  // Remembered even if a message failed, so the same change isn't re-sent every hour.
  await deps.alertState.set(next);
  return { hour: m.hour, date: m.date, subscribers: subs.length, alerts: alerts.map((a) => a.kind), results };
}
