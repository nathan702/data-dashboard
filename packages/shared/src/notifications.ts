import { z } from "zod";
import { BUSINESS_LINE_INFO, BUSINESS_LINES, type BusinessLine } from "./businessLines.js";
import type { IsoDate } from "./dates.js";
import { SOURCE_INFO, type Source } from "./sources.js";
import { TARGET_MEASURE_INFO, TARGET_STATUS_LABEL, type TargetProgressResponse, type TargetStatus } from "./targets.js";
import type { SourceFreshness } from "./types.js";
import type { ReturningSummary } from "./returning.js";

/**
 * Digests and alerts. Each person chooses on My notifications what reaches
 * them and where (a Slack direct message; email later). Content is totals
 * only: revenue, targets, sign-up counts, sync health. Never names.
 */

export const DIGEST_HOURS = [6, 7, 8, 9, 10] as const;
export const DAILY_MODES = ["off", "weekdays", "every_day"] as const;
export type DailyMode = (typeof DAILY_MODES)[number];

export interface NotificationSettings {
  /** Where to send: a Slack direct message, email (coming next). */
  slack: boolean;
  email: boolean;
  /** Daily digest (yesterday): off, Monday–Friday, or every day. */
  daily: DailyMode;
  /** Weekly digest on Monday (last week); it replaces that Monday's daily one. */
  weekly: boolean;
  /** Hour (Eastern) digests arrive. */
  hour: (typeof DIGEST_HOURS)[number];
  /** Lines covered by digests and alerts; null = the person's tabs. */
  lines: BusinessLine[] | null;
  alerts: {
    /** A target turns behind pace, and when it recovers. */
    targetBehind: boolean;
    /** Yesterday's revenue (by date booked) was this far above or below the same day last year. */
    bigDay: boolean;
    bigDayPercent: number;
    /** Admins: a platform stopped syncing, and when it's back. */
    syncStale: boolean;
    /** Admins: revenue arrived that isn't assigned to a business line. */
    unassigned: boolean;
  };
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  slack: false,
  email: false,
  daily: "off",
  weekly: false,
  hour: 7,
  lines: null,
  alerts: { targetBehind: false, bigDay: false, bigDayPercent: 50, syncStale: false, unassigned: false },
};

export const notificationSettingsSchema = z.object({
  slack: z.boolean(),
  email: z.boolean(),
  daily: z.enum(DAILY_MODES),
  weekly: z.boolean(),
  hour: z.number().int().refine((h) => (DIGEST_HOURS as readonly number[]).includes(h), "Digests arrive between 6am and 10am"),
  lines: z.array(z.enum(BUSINESS_LINES)).max(BUSINESS_LINES.length).nullable(),
  alerts: z.object({
    targetBehind: z.boolean(),
    bigDay: z.boolean(),
    bigDayPercent: z.number().int().min(10).max(500),
    syncStale: z.boolean(),
    unassigned: z.boolean(),
  }),
});

export function cleanNotificationSettings(raw: unknown): NotificationSettings {
  const merged = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(raw as object), alerts: { ...DEFAULT_NOTIFICATION_SETTINGS.alerts, ...((raw as { alerts?: object } | null)?.alerts ?? {}) } };
  const parsed = notificationSettingsSchema.safeParse(merged);
  if (!parsed.success) return DEFAULT_NOTIFICATION_SETTINGS;
  const lines = parsed.data.lines ? [...new Set(parsed.data.lines)] : null;
  return { ...(parsed.data as NotificationSettings), lines };
}

/** Admin-only alerts are switched off for everyone else. */
export function withoutAdminAlerts(s: NotificationSettings): NotificationSettings {
  return { ...s, alerts: { ...s.alerts, syncStale: false, unassigned: false } };
}

/** Whether a person gets anything at all. */
export const notificationsOn = (s: NotificationSettings) => s.slack || s.email;

/** The moment the hourly job runs, in Eastern time. */
export interface EasternMoment {
  date: IsoDate;
  hour: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export function easternMoment(at: Date): EasternMoment {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

/** Which digest is due for this person now: the weekly one on Mondays (if on), else the daily one. */
export function digestDue(s: NotificationSettings, m: EasternMoment): "daily" | "weekly" | null {
  if (!notificationsOn(s) || m.hour !== s.hour) return null;
  if (s.weekly && m.weekday === 1) return "weekly";
  if (s.daily === "every_day") return "daily";
  if (s.daily === "weekdays" && m.weekday >= 1 && m.weekday <= 5) return "daily";
  return null;
}

// ---------- digest content ----------

export interface DigestLineRow {
  line: BusinessLine;
  /** Net revenue by date booked (sales made in the period). */
  revenue: number;
  /** The same days last year (same weekdays for Events and Haunted Forest). */
  previous: number | null;
  /** Campminder sign-ups in the period (lines fed by Campminder). */
  signups: { enrollments: number; campers: number } | null;
}

export interface DigestContent {
  kind: "daily" | "weekly";
  period: { start: IsoDate; end: IsoDate };
  rows: DigestLineRow[];
  targets: TargetProgressResponse[];
  /** Camp's returning families while their registration is under way (shown with Camp). */
  returning?: ReturningSummary | null;
  /** Platforms not synced lately. */
  stale: Source[];
  /** Link to the dashboard. */
  url: string;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-US");
const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (d: IsoDate) => dayFmt.format(new Date(`${d}T00:00:00Z`));
const change = (cur: number, prev: number | null) => {
  if (prev === null || prev === 0) return "";
  const p = (cur - prev) / Math.abs(prev);
  return ` (${p >= 0 ? "+" : "−"}${Math.abs(p * 100).toFixed(0)}% vs last year)`;
};
const STATUS_ICON: Record<TargetStatus, string> = { ahead: "🟢", on_track: "🟢", reached: "✅", behind: "🔴", missed: "🔴", no_pace: "⚪" };

/** A digest as Slack text (mrkdwn), for the chosen lines only. */
export function digestSlackText(c: DigestContent, lines: BusinessLine[]): string {
  const rows = c.rows.filter((r) => lines.includes(r.line));
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  const prevs = rows.map((r) => r.previous);
  const totalPrev = prevs.every((p) => p === null) ? null : prevs.reduce<number>((s, p) => s + (p ?? 0), 0);
  const when = c.kind === "daily" ? fmtDay(c.period.start) : `${fmtDay(c.period.start)} – ${fmtDay(c.period.end)}`;
  const out: string[] = [];
  out.push(`*${c.kind === "daily" ? "Daily" : "Weekly"} digest · ${when}*`);
  out.push(`Booked ${c.kind === "daily" ? "that day" : "that week"} (net): *${usd.format(total)}*${change(total, totalPrev)}`);
  for (const r of rows) {
    if (r.revenue === 0 && !r.previous && !r.signups?.enrollments) continue;
    const signups = r.signups && r.signups.enrollments > 0 ? ` · ${int.format(r.signups.enrollments)} sign-ups (${int.format(r.signups.campers)} campers)` : "";
    out.push(`• ${BUSINESS_LINE_INFO[r.line].label}: ${usd.format(r.revenue)}${change(r.revenue, r.previous)}${signups}`);
  }
  const back = c.returning;
  if (back && lines.includes("camp") && back.current.families > 0) {
    const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
    const prev = back.previous ? ` · last year ${pct(back.previous.samePoint, back.previous.families)} at this point` : "";
    out.push(
      `• Camp returning families ${back.season}: ${int.format(back.current.enrolled)} of ${int.format(back.current.families)} re-enrolled (${pct(back.current.enrolled, back.current.families)})${prev}`,
    );
  }
  // Finished seasons are settled; digests follow the ones under way.
  const targets = c.targets.filter((t) => lines.includes(t.businessLine) && t.rows.length > 0 && !t.ended);
  if (targets.length) {
    out.push("", "*Targets*");
    for (const t of targets) {
      for (const r of t.rows) {
        const money = TARGET_MEASURE_INFO[r.measure].money;
        const f = (n: number) => (money ? usd.format(n) : int.format(Math.round(n)));
        const pct = r.target > 0 ? `${Math.round((r.actual / r.target) * 100)}%` : "–";
        out.push(
          `${STATUS_ICON[r.status]} ${BUSINESS_LINE_INFO[t.businessLine].label} ${t.season} ${TARGET_MEASURE_INFO[r.measure].label.toLowerCase()}: ${f(r.actual)} of ${f(r.target)} (${pct}) · ${TARGET_STATUS_LABEL[r.status]}`,
        );
      }
    }
  }
  out.push("");
  out.push(c.stale.length ? `⚠️ Not synced lately: ${c.stale.map((s) => SOURCE_INFO[s].label).join(", ")}.` : "All data is up to date.");
  out.push(`<${c.url}|Open the dashboard>`);
  return out.join("\n");
}

// ---------- alerts ----------

/** How long each platform may go without a successful sync before it counts as stale. */
export const STALE_AFTER_HOURS: Record<Source, number> = { shopify: 2, square: 2, hubspot: 2, fareharbor: 3, campminder: 26 };

export function staleSources(freshness: SourceFreshness[], now: Date): Source[] {
  return freshness
    .filter((f) => {
      if (f.status === "never_run") return false;
      if (f.status === "error") return true;
      const last = f.lastSuccessAt ? Date.parse(f.lastSuccessAt) : NaN;
      return Number.isFinite(last) && now.getTime() - last > STALE_AFTER_HOURS[f.source] * 3_600_000;
    })
    .map((f) => f.source);
}

export type AlertKind = "target_behind" | "target_recovered" | "big_day" | "sync_stale" | "sync_recovered" | "unassigned";

export interface Alert {
  kind: AlertKind;
  /** The line it's about (targets, big days); null for platform alerts. */
  line: BusinessLine | null;
  text: string;
  /** Big days: the change from last year (0.6 = +60%). */
  change?: number;
}

/** What the alerts last saw, so each fires once per change. Stored in Firestore. */
export interface AlertState {
  /** "line:season:measure" → last status. */
  targets: Record<string, TargetStatus>;
  /** Platform → stale when last checked. */
  stale: Partial<Record<Source, boolean>>;
  unassigned: boolean;
  /** Day big-day alerts were last worked out for. */
  bigDayFor: IsoDate | null;
}

export const EMPTY_ALERT_STATE: AlertState = { targets: {}, stale: {}, unassigned: false, bigDayFor: null };

/**
 * Targets that turned behind, or recovered, since last time. A target seen
 * for the first time is only recorded (no alert), so turning alerts on
 * doesn't send a burst; finished seasons are left alone.
 */
export function targetAlerts(prev: AlertState["targets"], progress: TargetProgressResponse[]): { alerts: Alert[]; next: AlertState["targets"] } {
  const next: AlertState["targets"] = { ...prev };
  const alerts: Alert[] = [];
  for (const p of progress) {
    if (p.season === null || p.ended) continue;
    for (const r of p.rows) {
      const key = `${p.businessLine}:${p.season}:${r.measure}`;
      const before = prev[key];
      next[key] = r.status;
      if (before === undefined || before === r.status) continue;
      const what = `${BUSINESS_LINE_INFO[p.businessLine].label} ${p.season} ${TARGET_MEASURE_INFO[r.measure].label.toLowerCase()}`;
      const money = TARGET_MEASURE_INFO[r.measure].money;
      const f = (n: number) => (money ? usd.format(n) : int.format(Math.round(n)));
      const detail = `${f(r.actual)} now; ${r.expected === null ? "no pace yet" : `${f(r.expected)} expected by now`}; target ${f(r.target)}.`;
      if (r.status === "behind") alerts.push({ kind: "target_behind", line: p.businessLine, text: `🔴 ${what} is behind pace: ${detail}` });
      else if (before === "behind" && (r.status === "on_track" || r.status === "ahead"))
        alerts.push({ kind: "target_recovered", line: p.businessLine, text: `🟢 ${what} is back ${r.status === "ahead" ? "ahead of" : "on"} pace: ${detail}` });
    }
  }
  return { alerts, next };
}

export function syncAlerts(prev: AlertState["stale"], stale: Source[], connected: Source[]): { alerts: Alert[]; next: AlertState["stale"] } {
  const next: AlertState["stale"] = {};
  const alerts: Alert[] = [];
  for (const s of connected) {
    const now = stale.includes(s);
    next[s] = now;
    if (now && !prev[s]) alerts.push({ kind: "sync_stale", line: null, text: `⚠️ ${SOURCE_INFO[s].label} hasn't synced in over ${STALE_AFTER_HOURS[s]} hours. Data status has the details.` });
    if (!now && prev[s]) alerts.push({ kind: "sync_recovered", line: null, text: `✅ ${SOURCE_INFO[s].label} is syncing again.` });
  }
  return { alerts, next };
}

/** Yesterday's lines that moved a lot against the same day last year (each person's threshold is applied when sending). */
export function bigDayAlerts(rows: DigestLineRow[], day: IsoDate): Alert[] {
  return rows.flatMap((r) => {
    // Small days swing wildly; only compare days that matter.
    if (r.previous === null || Math.abs(r.previous) < 500) return [];
    const c = (r.revenue - r.previous) / Math.abs(r.previous);
    const dir = c >= 0 ? "up" : "down";
    return [
      {
        kind: "big_day" as const,
        line: r.line,
        change: c,
        text: `${c >= 0 ? "📈" : "📉"} ${BUSINESS_LINE_INFO[r.line].label} booked ${usd.format(r.revenue)} on ${fmtDay(day)}, ${dir} ${Math.abs(c * 100).toFixed(0)}% from ${usd.format(r.previous)} the same day last year.`,
      },
    ];
  });
}

/** Whether an alert goes to this person (their alert choices, lines and big-day threshold). */
export function alertWanted(a: Alert, s: NotificationSettings, lines: BusinessLine[]): boolean {
  if (!notificationsOn(s)) return false;
  if (a.line && !lines.includes(a.line)) return false;
  switch (a.kind) {
    case "target_behind":
    case "target_recovered":
      return s.alerts.targetBehind;
    case "big_day":
      return s.alerts.bigDay && Math.abs(a.change ?? 0) * 100 >= s.alerts.bigDayPercent;
    case "sync_stale":
    case "sync_recovered":
      return s.alerts.syncStale;
    case "unassigned":
      return s.alerts.unassigned;
  }
}

/** The My notifications page: a person's settings and what can be delivered. */
export interface MyNotificationsResponse {
  settings: NotificationSettings;
  slackConfigured: boolean;
  emailConfigured: boolean;
}
