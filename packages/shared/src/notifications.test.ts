import { describe, expect, it } from "vitest";
import {
  alertWanted,
  bigDayAlerts,
  cleanNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  digestDue,
  digestSlackText,
  easternMoment,
  staleSources,
  syncAlerts,
  targetAlerts,
  withoutAdminAlerts,
  type DigestContent,
  type NotificationSettings,
} from "./notifications.js";
import type { TargetProgressResponse } from "./targets.js";

const on: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, slack: true, daily: "weekdays", weekly: true, hour: 7 };

const progress = (status: "ahead" | "on_track" | "behind", ended = false): TargetProgressResponse => ({
  businessLine: "farm_store",
  season: 2026,
  seasons: [2026],
  range: { start: "2026-01-01", end: "2026-12-31" },
  asOf: "2026-11-23",
  ended,
  samePoint: "2025-11-23",
  alignedBy: "date",
  rows: [{ measure: "revenue", target: 950_000, actual: 725_800, expected: 879_974, status, lastSeason: { atSamePoint: 1, final: 1 } }],
});

describe("notification settings", () => {
  it("fills in missing fields and drops bad ones", () => {
    expect(cleanNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(cleanNotificationSettings({ slack: true, alerts: { bigDay: true } })).toMatchObject({ slack: true, alerts: { bigDay: true, bigDayPercent: 50 } });
    expect(cleanNotificationSettings({ ...on, hour: 3 })).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(cleanNotificationSettings({ ...on, lines: ["camp", "camp", "farm_store"] }).lines).toEqual(["camp", "farm_store"]);
    expect(withoutAdminAlerts({ ...on, alerts: { ...on.alerts, syncStale: true, unassigned: true } }).alerts).toMatchObject({ syncStale: false, unassigned: false });
  });

  it("reads the hour and weekday in Eastern time", () => {
    // 12:05 UTC on Monday Nov 23, 2026 is 7:05am Eastern.
    expect(easternMoment(new Date("2026-11-23T12:05:00Z"))).toEqual({ date: "2026-11-23", hour: 7, weekday: 1 });
    // 03:00 UTC Sunday is still Saturday evening in Eastern time.
    expect(easternMoment(new Date("2026-11-22T03:00:00Z"))).toMatchObject({ date: "2026-11-21", weekday: 6 });
  });

  it("sends the weekly digest on Mondays and the daily one on the chosen days, at the chosen hour", () => {
    const at = (weekday: number, hour = 7) => ({ date: "2026-11-23", hour, weekday });
    expect(digestDue(on, at(1))).toBe("weekly");
    expect(digestDue({ ...on, weekly: false }, at(1))).toBe("daily");
    expect(digestDue(on, at(2))).toBe("daily");
    expect(digestDue(on, at(6))).toBeNull();
    expect(digestDue({ ...on, daily: "every_day" }, at(6))).toBe("daily");
    expect(digestDue(on, at(2, 8))).toBeNull();
    expect(digestDue({ ...on, slack: false }, at(2))).toBeNull();
  });
});

describe("digests", () => {
  const c: DigestContent = {
    kind: "daily",
    period: { start: "2026-11-22", end: "2026-11-22" },
    rows: [
      { line: "camp", revenue: 12_000, previous: 10_000, signups: { enrollments: 14, campers: 9 } },
      { line: "farm_store", revenue: 2_500, previous: 2_000, signups: null },
    ],
    targets: [progress("behind")],
    stale: ["square"],
    url: "https://data.calleva.org",
  };
  it("lists only the person's lines, with totals, targets and sync health", () => {
    const t = digestSlackText(c, ["camp", "farm_store"]);
    expect(t).toContain("*Daily digest · Sun, Nov 22*");
    expect(t).toContain("*$14,500* (+21% vs last year)");
    expect(t).toContain("• Camp: $12,000 (+20% vs last year) · 14 sign-ups (9 campers)");
    expect(t).toContain("🔴 Farm Store 2026 net revenue: $725,800 of $950,000 (76%) · Behind");
    expect(t).toContain("Not synced lately: Square");
    const campOnly = digestSlackText(c, ["camp"]);
    expect(campOnly).not.toContain("Farm Store");
    expect(campOnly).toContain("*$12,000*");
    expect(digestSlackText({ ...c, targets: [progress("behind", true)] }, ["farm_store"])).not.toContain("Targets");
  });
});

describe("alerts", () => {
  it("fires once when a target turns behind, and again when it recovers; never on first sight or finished seasons", () => {
    const first = targetAlerts({}, [progress("on_track")]);
    expect(first.alerts).toEqual([]);
    const behind = targetAlerts(first.next, [progress("behind")]);
    expect(behind.alerts.map((a) => a.kind)).toEqual(["target_behind"]);
    expect(behind.alerts[0]!.text).toContain("Farm Store 2026 net revenue is behind pace");
    expect(targetAlerts(behind.next, [progress("behind")]).alerts).toEqual([]);
    expect(targetAlerts(behind.next, [progress("ahead")]).alerts.map((a) => a.kind)).toEqual(["target_recovered"]);
    expect(targetAlerts(first.next, [progress("behind", true)]).alerts).toEqual([]);
  });

  it("flags platforms that stopped syncing, and when they're back", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const fresh = [
      { source: "square" as const, status: "ok" as const, lastDataAt: null, lastSuccessAt: "2026-11-23T09:00:00Z", lastError: null },
      { source: "campminder" as const, status: "ok" as const, lastDataAt: null, lastSuccessAt: "2026-11-23T09:00:00Z", lastError: null },
      { source: "hubspot" as const, status: "error" as const, lastDataAt: null, lastSuccessAt: null, lastError: "401" },
      { source: "shopify" as const, status: "never_run" as const, lastDataAt: null, lastSuccessAt: null, lastError: null },
    ];
    const stale = staleSources(fresh, now);
    expect(stale).toEqual(["square", "hubspot"]);
    const a = syncAlerts({}, stale, ["square", "campminder", "hubspot"]);
    expect(a.alerts.map((x) => x.kind)).toEqual(["sync_stale", "sync_stale"]);
    const b = syncAlerts(a.next, ["hubspot"], ["square", "campminder", "hubspot"]);
    expect(b.alerts.map((x) => x.text)).toEqual(["✅ Square is syncing again."]);
  });

  it("applies each person's lines, choices and big-day threshold", () => {
    const [up] = bigDayAlerts([{ line: "camp", revenue: 18_000, previous: 10_000, signups: null }], "2026-11-22");
    expect(up!.text).toContain("up 80%");
    expect(bigDayAlerts([{ line: "camp", revenue: 900, previous: 100, signups: null }], "2026-11-22")).toEqual([]);
    const s = { ...on, alerts: { ...on.alerts, bigDay: true, bigDayPercent: 50 } };
    expect(alertWanted(up!, s, ["camp"])).toBe(true);
    expect(alertWanted(up!, { ...s, alerts: { ...s.alerts, bigDayPercent: 100 } }, ["camp"])).toBe(false);
    expect(alertWanted(up!, s, ["farm_store"])).toBe(false);
    expect(alertWanted(up!, { ...s, slack: false }, ["camp"])).toBe(false);
  });
});
