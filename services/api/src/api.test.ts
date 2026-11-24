import { describe, expect, it } from "vitest";
import { reportSpecSchema, type CampminderExtras } from "@dash/shared";
import request from "supertest";
import { createApi } from "./app.js";
import { decideAccess, type AuthDeps } from "./auth.js";
import { loadConfig } from "./config.js";
import { MemoryPreferences } from "./preferences.js";
import { NoopTrigger } from "./refresh.js";
import { MemorySeasonSettings } from "./seasons.js";
import { MemoryTargets } from "./targets.js";
import { MemoryAlertState, MemoryNotifications } from "./notifications.js";
import { runNotifications } from "./notify.js";
import { MemoryMessenger, NoMessenger, type Messenger } from "./slack.js";
import { MemoryProgramFamilies, MemoryReports, MemorySchools } from "./reports.js";
import { DEMO_OFFICIAL_SCHOOLS } from "./warehouse/demoSchools.js";
import { CALENDAR_YEAR, campminderCalendar, DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_SEASON_SETTINGS, SOURCES, type SourceFreshness } from "@dash/shared";
import { DEMO_STREAMS, DemoFreshness, DemoWarehouse, demoRow } from "./warehouse/demo.js";
import { periodBucket, summarizeRows } from "./warehouse/summarize.js";

// Shaped like a real Firebase ID token from Google sign-in (no "hd" claim).
const org = { email: "pat@calleva.org", email_verified: true, name: "Pat", firebase: { sign_in_provider: "google.com" } };

describe("access decisions", () => {
  const open = { allowedEmails: [], admins: ["pat@calleva.org"] };
  it("allows verified accounts in the organization domain", () => {
    expect(decideAccess(org, open, ["calleva.org"])).toEqual({
      ok: true,
      viewer: { email: "pat@calleva.org", name: "Pat", isAdmin: true, adminsUnconfigured: false },
    });
  });
  it("rejects personal accounts, unverified emails and non-Google sign-in", () => {
    expect(decideAccess({ ...org, email: "pat@gmail.com" }, open, ["calleva.org"]).ok).toBe(false);
    expect(decideAccess({ ...org, email_verified: false }, open, ["calleva.org"]).ok).toBe(false);
    expect(decideAccess({ ...org, firebase: { sign_in_provider: "password" } }, open, ["calleva.org"]).ok).toBe(false);
    expect(decideAccess({ ...org, firebase: undefined }, open, ["calleva.org"]).ok).toBe(false);
  });
  it("treats everyone as admin until an admin list exists", () => {
    const d = decideAccess(org, { allowedEmails: [], admins: [] }, ["calleva.org"]);
    expect(d.ok && d.viewer.isAdmin && d.viewer.adminsUnconfigured).toBe(true);
    const e = decideAccess(org, { allowedEmails: [], admins: ["boss@calleva.org"] }, ["calleva.org"]);
    expect(e.ok && e.viewer.isAdmin).toBe(false);
  });

  it("enforces the allow-list when one is set", () => {
    const list = { allowedEmails: ["someone@calleva.org"], admins: [] };
    expect(decideAccess(org, list, ["calleva.org"]).ok).toBe(false);
    expect(decideAccess({ ...org, email: "Someone@calleva.org" }, list, ["calleva.org"]).ok).toBe(true);
  });
});

describe("config", () => {
  it("refuses to disable auth on Cloud Run", () => {
    expect(() => loadConfig({ AUTH_DISABLED: "1", K_SERVICE: "api" })).toThrow();
  });
  it("requires an allowed domain when auth is on", () => {
    expect(() => loadConfig({})).toThrow();
    expect(loadConfig({ ALLOWED_DOMAINS: "Calleva.org" }).allowedDomains).toEqual(["calleva.org"]);
  });
});

function api(auth: AuthDeps | null = null, refresh = new NoopTrigger(), messenger: Messenger = new MemoryMessenger()) {
  return createApi({
    auth,
    warehouse: new DemoWarehouse(),
    freshness: new DemoFreshness(),
    preferences: new MemoryPreferences(),
    seasons: new MemorySeasonSettings(),
    targets: new MemoryTargets(),
    notifications: new MemoryNotifications(),
    messenger,
    appUrl: "https://data.calleva.org",
    reports: new MemoryReports(),
    programFamilies: new MemoryProgramFamilies(),
    schools: new MemorySchools(),
    officialSchools: DEMO_OFFICIAL_SCHOOLS,
    refresh,
    corsOrigins: ["https://dash.web.app"],
    cacheTtlSeconds: 60,
  });
}

describe("api", () => {
  const auth: AuthDeps = {
    allowedDomains: ["calleva.org"],
    loadAccessList: async () => ({ allowedEmails: [], admins: [] }),
    verifyIdToken: async (t) => {
      if (t === "good") return org;
      if (t === "outsider") return { email: "x@gmail.com", email_verified: true };
      throw new Error("bad token");
    },
  };

  it("requires sign-in", async () => {
    await request(api(auth)).get("/api/me").expect(401);
    await request(api(auth)).get("/api/me").set("Authorization", "Bearer nope").expect(401);
    await request(api(auth)).get("/api/me").set("Authorization", "Bearer outsider").expect(403);
    const res = await request(api(auth)).get("/api/me").set("Authorization", "Bearer good").expect(200);
    expect(res.body.email).toBe("pat@calleva.org");
  });

  it("validates revenue queries", async () => {
    await request(api()).get("/api/revenue/summary?start=2026-02-30&end=2026-03-01").expect(400);
    await request(api()).get("/api/revenue/summary?start=2026-03-02&end=2026-03-01").expect(400);
    await request(api()).get("/api/revenue/summary?start=2026-03-01&end=2026-03-02&basis=bogus").expect(400);
  });

  it("returns totals per business line with a comparison", async () => {
    const res = await request(api())
      .get("/api/revenue/summary?start=2026-06-01&end=2026-06-30&businessLines=events,farm_store&granularity=week")
      .expect(200);
    expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(["events", "farm_store"]);
    expect(res.body.comparisonRange).toEqual({ start: "2025-06-01", end: "2025-06-30" });
    expect(res.body.groups[0].current.gross).toBeGreaterThan(0);
    expect(res.body.series.every((p: { period: string }) => p.period >= "2026-05-25")).toBe(true);
  });

  it("can split one business line by platform", async () => {
    const res = await request(api())
      .get("/api/revenue/summary?start=2026-06-01&end=2026-06-30&businessLines=events&groupBy=source&sources=fareharbor,square")
      .expect(200);
    expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(["fareharbor", "square"]);
    expect(res.body.groups.every((g: { current: { gross: number } }) => g.current.gross > 0)).toBe(true);
  });

  it("only reflects allowed CORS origins", async () => {
    const ok = await request(api()).get("/healthz").set("Origin", "https://dash.web.app");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://dash.web.app");
    const bad = await request(api()).get("/healthz").set("Origin", "https://evil.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("aggregation", () => {
  it("buckets weeks starting Monday and computes net measures", () => {
    expect(periodBucket("2026-09-23", "week", CALENDAR_YEAR)).toBe("2026-09-21");
    expect(periodBucket("2026-09-21", "week", CALENDAR_YEAR)).toBe("2026-09-21");
    expect(periodBucket("2026-09-20", "week", CALENDAR_YEAR)).toBe("2026-09-14");
    expect(periodBucket("2026-09-20", "season", campminderCalendar())).toBe("2026-09-07");
    const base = { businessLine: "farm_store" as const, source: "square" as const };
    const rows = [
      { ...base, date: "2026-01-01", gross: 100, discounts: 10, refunds: 5, fees: 3, transactions: 2 },
      { ...base, date: "2025-01-01", gross: 50, discounts: 0, refunds: 0, fees: 1, transactions: 1 },
    ];
    const s = summarizeRows(rows, {
      start: "2026-01-01", end: "2026-01-01", basis: "booked", measure: "net_after_fees", granularity: "day",
      compare: "previous_year", groupBy: "business_line", businessLines: ["farm_store"],
    }, CALENDAR_YEAR);
    expect(s.groups[0]!.current).toMatchObject({ gross: 100, net: 85, netAfterFees: 82, transactions: 2 });
    expect(s.groups[0]!.comparison).toMatchObject({ gross: 50, netAfterFees: 49 });
    expect(s.series).toEqual([{ period: "2026-01-01", key: "farm_store", value: 82 }]);
  });

  it("demo data is deterministic", () => {
    expect(demoRow(DEMO_STREAMS[0]!, "2026-01-05", "booked")).toEqual(demoRow(DEMO_STREAMS[0]!, "2026-01-05", "booked"));
  });
});

describe("same-weekday comparison", () => {
  it("compares with the same weekdays last year", async () => {
    const q = "start=2026-10-02&end=2026-10-04&basis=booked&measure=net&granularity=day&compare=previous_year_weekday&groupBy=business_line&businessLines=haunted_forest";
    const res = await request(api()).get(`/api/revenue/summary?${q}`).expect(200);
    expect(res.body.comparisonRange).toEqual({ start: "2025-10-03", end: "2025-10-05" });
    // Last year's points are drawn on this year's dates.
    for (const p of res.body.comparisonSeries) expect(p.period >= "2026-10-02" && p.period <= "2026-10-04").toBe(true);
    const k = await request(api()).get("/api/retail/square/kpis?start=2026-10-02&end=2026-10-04&compare=previous_year_weekday").expect(200);
    expect(k.body.comparisonRange.start).toBe("2025-10-03");
  });
});

describe("retail endpoints", () => {
  it("returns KPIs with comparison and derived net/AOV", async () => {
    const res = await request(api()).get("/api/retail/square/kpis?start=2026-07-01&end=2026-07-31&businessLine=farm_store").expect(200);
    expect(res.body.businessLine).toBe("farm_store");
    const k = res.body.current;
    expect(k.orders).toBeGreaterThan(0);
    expect(k.net).toBeCloseTo(k.gross - k.discounts - k.refunds, 1);
    expect(k.averageOrderValue).toBeCloseTo(k.net / k.orders, 1);
    expect(res.body.comparison).not.toBeNull();
  });

  it("returns breakdowns sorted by net and honors the limit", async () => {
    const res = await request(api()).get("/api/retail/shopify/breakdown?start=2026-07-01&end=2026-07-31&dimension=item&limit=3").expect(200);
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.truncated).toBe(true);
    const nets = res.body.rows.map((r: { net: number }) => r.net);
    expect([...nets].sort((a, b) => b - a)).toEqual(nets);
  });

  it("limits a platform's breakdown to one business line", async () => {
    const all = await request(api()).get("/api/retail/square/breakdown?start=2026-07-01&end=2026-07-31&dimension=location").expect(200);
    const events = await request(api()).get("/api/retail/square/breakdown?start=2026-07-01&end=2026-07-31&dimension=location&businessLine=events").expect(200);
    const keys = (r: { body: { rows: Array<{ key: string }> } }) => r.body.rows.map((x) => x.key).sort();
    expect(keys(all)).toEqual(["Events", "Farm Store", "MHF", "Pizza Nights"]);
    expect(keys(events)).toEqual(["Events", "Pizza Nights"]);
  });

  it("rejects unknown platforms, dimensions and business lines", async () => {
    await request(api()).get("/api/retail/hubspot/kpis?start=2026-07-01&end=2026-07-31").expect(404);
    await request(api()).get("/api/retail/shopify/breakdown?start=2026-07-01&end=2026-07-31&dimension=customer").expect(400);
    await request(api()).get("/api/retail/square/kpis?start=2026-07-01&end=2026-07-31&businessLine=nope").expect(400);
  });

  it("drills down: filters narrow both the totals and the breakdown", async () => {
    const base = "start=2026-07-01&end=2026-07-31&businessLine=farm_store";
    const cats = await request(api()).get(`/api/retail/square/breakdown?${base}&dimension=category`).expect(200);
    const top = cats.body.rows[0];
    const f = encodeURIComponent(JSON.stringify({ category: [top.key] }));
    const k = await request(api()).get(`/api/retail/square/kpis?${base}&filters=${f}`).expect(200);
    expect(k.body.filtered).toBe(true);
    expect(k.body.current.gross).toBeCloseTo(top.gross, 0);
    expect(k.body.comparison.gross).toBeGreaterThan(0);
    const items = await request(api()).get(`/api/retail/square/breakdown?${base}&dimension=item&filters=${f}`).expect(200);
    const sum = items.body.rows.reduce((t: number, r: { gross: number }) => t + r.gross, 0);
    expect(sum).toBeCloseTo(top.gross, 0);
    const unfiltered = await request(api()).get(`/api/retail/square/kpis?${base}`).expect(200);
    expect(unfiltered.body.filtered).toBe(false);
    await request(api()).get(`/api/retail/square/kpis?${base}&filters=${encodeURIComponent('{"customer":["x"]}')}`).expect(400);
  });

  it("serves the inventory snapshot", async () => {
    const res = await request(api()).get("/api/shopify/inventory").expect(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
  });
});

describe("retail SQL", () => {
  it("only interpolates fixed fragments", async () => {
    const { breakdownSql, kpiSql } = await import("./warehouse/retailSql.js");
    for (const d of ["item", "variant", "category", "location", "channel"] as const) {
      const sql = breakdownSql("marts", d);
      expect(sql).toContain("source = @source");
      expect(sql).toContain("@business_line IS NULL");
      expect(sql).toContain("LIMIT @limit_plus_one");
    }
    expect(kpiSql("marts")).toContain("fct_retail_orders");
    const { filteredKpiSql, retailDrillParams } = await import("./warehouse/retailSql.js");
    const { params } = retailDrillParams({ item: ["Eggs"] });
    for (const sql of [filteredKpiSql("marts"), breakdownSql("marts", "item")]) for (const p of Object.keys(params)) expect(sql).toContain(`@${p}`);
  });
});

describe("overlapping comparison", () => {
  it("counts days in both periods when a long range overlaps last year", () => {
    const row = (date: string, gross: number) => ({ businessLine: "farm_store" as const, source: "square" as const, date, gross, discounts: 0, refunds: 0, fees: 0, transactions: 1 });
    // Two years against the two years before (shifted one year): 2025 is in both.
    const s = summarizeRows([row("2024-06-01", 10), row("2025-06-01", 20), row("2026-06-01", 40)], {
      start: "2025-01-01", end: "2026-12-31", basis: "booked", measure: "gross", granularity: "season",
      compare: "previous_year", groupBy: "business_line", businessLines: ["farm_store"],
    }, CALENDAR_YEAR);
    expect(s.groups[0]!.current.gross).toBe(60);
    expect(s.groups[0]!.comparison!.gross).toBe(30);
  });

  it("tags SQL rows per period instead of choosing one", async () => {
    const { kpiSql } = await import("./warehouse/retailSql.js");
    expect(kpiSql("marts")).toContain("ARRAY_CONCAT");
    expect(kpiSql("marts")).not.toContain("@end, 'current', 'comparison')");
  });
});

describe("comparison series", () => {
  it("puts last year's values on this year's buckets", () => {
    const row = (date: string, gross: number) => ({ businessLine: "farm_store" as const, source: "square" as const, date, gross, discounts: 0, refunds: 0, fees: 0, transactions: 1 });
    const s = summarizeRows([row("2026-06-02", 100), row("2025-06-02", 60), row("2025-06-03", 40)], {
      start: "2026-06-01", end: "2026-06-07", basis: "booked", measure: "gross", granularity: "week",
      compare: "previous_year", groupBy: "business_line", businessLines: ["farm_store"],
    }, CALENDAR_YEAR);
    expect(s.series).toEqual([{ period: "2026-06-01", key: "farm_store", value: 100 }]);
    expect(s.comparisonSeries).toEqual([{ period: "2026-06-01", key: "farm_store", value: 100 }]);
  });
});

describe("season settings", () => {
  const admin = (admins: string[]): AuthDeps => ({
    allowedDomains: ["calleva.org"],
    loadAccessList: async () => ({ allowedEmails: [], admins }),
    verifyIdToken: async () => org,
  });

  it("starts from the agreed rules and only lets admins change them", async () => {
    const res = await request(api()).get("/api/settings/seasons").expect(200);
    expect(res.body).toEqual(DEFAULT_SEASON_SETTINGS);
    const next = { ...DEFAULT_SEASON_SETTINGS, endDates: { haunted_forest: { "2026": "2026-11-08", "2027": "2027-11-06" } } };
    await request(api(admin(["boss@calleva.org"]))).put("/api/settings/seasons").set("Authorization", "Bearer t").send(next).expect(403);
    const app = api();
    await request(app).put("/api/settings/seasons").send({ ...next, rules: { ...next.rules, camp: "weekly" } }).expect(400);
    await request(app).put("/api/settings/seasons").send(next).expect(200);
    expect((await request(app).get("/api/settings/seasons")).body.endDates.haunted_forest["2027"]).toBe("2027-11-06");
  });

  it("buckets a line's revenue by its own seasons", async () => {
    const q = (line: string) =>
      `/api/revenue/summary?start=2025-10-01&end=2026-12-31&basis=service&measure=gross&granularity=season&compare=none&groupBy=business_line&businessLines=${line}`;
    const hf = await request(api()).get(q("haunted_forest")).expect(200);
    // Haunted Forest's 2026 season ended Nov 8; Nov 9 starts 2027.
    expect([...new Set(hf.body.series.map((p: { period: string }) => p.period))].sort()).toEqual(["2024-11-09", "2025-11-09", "2026-11-09"]);
    const rs = await request(api()).get(q("river_school")).expect(200);
    expect([...new Set(rs.body.series.map((p: { period: string }) => p.period))].sort()).toEqual(["2025-01-01", "2026-01-01"]);
  });
});

describe("settings", () => {
  const withAdmins = (admins: string[]): AuthDeps => ({
    allowedDomains: ["calleva.org"],
    loadAccessList: async () => ({ allowedEmails: [], admins }),
    verifyIdToken: async () => org,
  });

  it("lists assignments with built-in defaults", async () => {
    const res = await request(api()).get("/api/assignments").expect(200);
    const mhf = res.body.rows.find((r: { label: string }) => r.label === "MHF");
    expect(mhf).toMatchObject({ businessLine: "haunted_forest", origin: "default" });
    expect(res.body.rows.find((r: { label: string }) => r.label === "Old Kiosk").businessLine).toBe("unassigned");
    expect(res.body.canEdit).toBe(true);
  });

  it("saves changes, starts a refresh and validates input", async () => {
    const refresh = new NoopTrigger();
    const app = api(null, refresh);
    await request(app)
      .put("/api/assignments")
      .send({ changes: [{ source: "square", kind: "location", key: "LDEMOOLD", businessLine: "farm_store" }] })
      .expect(200);
    expect(refresh.triggered).toBe(1);
    const res = await request(app).get("/api/assignments").expect(200);
    expect(res.body.rows.find((r: { key: string }) => r.key === "LDEMOOLD")).toMatchObject({ businessLine: "farm_store", origin: "explicit" });
    await request(app).put("/api/assignments").send({ changes: [{ source: "square", kind: "location", key: "x", businessLine: "nope" }] }).expect(400);
  });

  it("only lets admins save", async () => {
    await request(api(withAdmins(["boss@calleva.org"])))
      .put("/api/assignments")
      .set("Authorization", "Bearer t")
      .send({ changes: [{ source: "square", kind: "location", key: "LDEMOOLD", businessLine: "events" }] })
      .expect(403);
    const res = await request(api(withAdmins(["boss@calleva.org"]))).get("/api/assignments").set("Authorization", "Bearer t").expect(200);
    expect(res.body.canEdit).toBe(false);
  });

  it("keeps each person's tab setup", async () => {
    const app = api();
    const initial = await request(app).get("/api/me/preferences").expect(200);
    expect(initial.body.tabs[0]).toBe("camp");
    await request(app).put("/api/me/preferences").send({ tabs: ["chaps", "camp"] }).expect(200);
    const after = await request(app).get("/api/me/preferences").expect(200);
    expect(after.body.tabs).toEqual(["chaps", "camp"]);
    await request(app).put("/api/me/preferences").send({ tabs: ["chaps", "chaps"] }).expect(400);
    await request(app).put("/api/me/preferences").send({ tabs: ["nope"] }).expect(400);
  });
});

describe("revenue SQL", () => {
  it("treats a missing (NULL) filter list as no filter", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const queries: string[] = [];
    const fake = { query: async (o: { query: string }) => (queries.push(o.query), [[]]) };
    await new BigQueryWarehouse(fake as never, "marts").revenueSummary({
      start: "2026-08-01", end: "2026-08-31", basis: "booked", measure: "net", granularity: "day",
      compare: "none", groupBy: "business_line", businessLines: ["farm_store"],
    }, CALENDAR_YEAR);
    for (const q of queries) {
      expect(q).toContain("COALESCE(ARRAY_LENGTH(@sources), 0) = 0");
      expect(q).toContain("COALESCE(ARRAY_LENGTH(@business_lines), 0) = 0");
    }
  });

  it("matches financial lines to filtered enrollments by person, else by household and session", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const queries: string[] = [];
    const fake = { query: async (o: { query: string }) => (queries.push(o.query), [[{}]]) };
    const w = new BigQueryWarehouse(fake as never, "marts");
    const r = await w.campminderFinance({ season: 2026, businessLine: "camp", filters: { session_group: ["Farm"] } });
    expect(r.filtered).toBe(true);
    const q = queries[0]!;
    // Payments are under the parent who paid: when the person isn't a camper in that session, the household is used.
    expect(q).toContain("IF(c.camper_hash IS NOT NULL, kp.camper_hash IS NOT NULL, kf.family_hash IS NOT NULL)");
    expect(q).toContain("kf.family_hash = tx.family_hash AND kf.session_name = tx.session_name");
    await w.campminderFinance({ season: 2026, filters: {} });
    expect(queries[1]).not.toContain("kept AS");
  });

  it("passes registration waves and camp locations as typed parameters", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const { DEFAULT_REGISTRATION } = await import("@dash/shared");
    const calls: Array<{ query: string; params: Record<string, unknown>; types: Record<string, unknown> }> = [];
    const fake = { query: async (o: (typeof calls)[number]) => (calls.push(o), [[]]) };
    await new BigQueryWarehouse(fake as never, "marts").registrationPace({ businessLine: "camp", filters: {} }, DEFAULT_REGISTRATION);
    const c = calls[0]!;
    expect(c.query).toContain("ARRAY_AGG(p.wave ORDER BY o.open_date, p.wave LIMIT 1)");
    expect(c.params.opens).toContainEqual({ season: 2026, wave: "va", open_date: "2026-01-06" });
    expect(c.params.locations).toContainEqual({ session_group: "Madeira", location: "va" });
    // Dates as text, parsed in the query: DATE fields inside an array parameter arrive empty.
    expect(c.types.opens).toEqual([{ season: "INT64", wave: "STRING", open_date: "STRING" }]);
    expect(c.query).toContain("SAFE.PARSE_DATE('%Y-%m-%d', open_date)");
  });

  it("buckets seasons from the line's season starts, passed as text and cast in the query", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; params: Record<string, unknown>; types: Record<string, unknown> }> = [];
    const fake = { query: async (o: never) => (calls.push(o), [[]]) };
    await new BigQueryWarehouse(fake as never, "marts").revenueSummary({
      start: "2026-01-01", end: "2026-10-31", basis: "service", measure: "net", granularity: "season",
      compare: "previous_year", groupBy: "business_line", businessLines: ["school_year"],
    }, campminderCalendar());
    const series = calls.find((c) => c.query.includes("UNNEST(@season_starts)"))!;
    expect(series.params.season_starts).toEqual(["2024-09-02", "2025-09-01", "2026-09-07"]);
    expect(series.types.season_starts).toEqual(["STRING"]);
    expect(series.query).toContain("CAST(s AS DATE)");
  });

  it("starts Campminder pace on each season's first day, passed as text and cast in the query", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; params: Record<string, unknown>; types: Record<string, unknown> }> = [];
    const fake = { query: async (o: never) => (calls.push(o), [[]]) };
    await new BigQueryWarehouse(fake as never, "marts").enrollmentSummary({ season: 2026, filters: {} }, campminderCalendar());
    const pace = calls.find((c) => c.query.includes("week_of_season"))!;
    expect(pace.params).toMatchObject({ cur_start: "2025-09-01", prev_start: "2024-09-02" });
    // Parameters typed DATE arrive empty (the chart went flat): dates travel as text.
    expect(pace.types).toMatchObject({ cur_start: "STRING", prev_start: "STRING" });
    expect(pace.query).toContain("CAST(IF(season = @season, @cur_start, @prev_start) AS DATE)");
    const kpi = calls.find((c) => c.query.includes("@prev_cutoff"))!;
    expect(kpi.types).toMatchObject({ prev_cutoff: "STRING" });
    expect(kpi.query).toContain("CAST(@prev_cutoff AS DATE)");
  });
});

describe("deploy self-check", () => {
  it("passes when the API's queries agree with the tables", async () => {
    const res = await request(api()).get("/healthz/deep").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.length).toBeGreaterThanOrEqual(5);
    expect(res.body.checks).toContainEqual({ name: "digests build", ok: true });
    // Runs every check against the demo data: several seconds, more on a busy machine.
  }, 30_000);

  it("fails when summaries come back empty (the zero-revenue bug)", async () => {
    const { runSelfCheck } = await import("./selfCheck.js");
    const demo = new DemoWarehouse();
    const broken = Object.create(demo) as DemoWarehouse;
    broken.revenueSummary = async (q) => {
      const r = await demo.revenueSummary(q);
      return { ...r, series: [], groups: r.groups.map((g) => ({ ...g, current: { ...g.current, gross: 0 } })) };
    };
    const result = await runSelfCheck(broken, (s, e) => demo.referenceTotals(s, e));
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "revenue summary by business_line matches tables",
      "revenue summary by source matches tables",
      "dates reach the queries",
    ]);
    // Runs every check against the demo data, like the test above.
  }, 30_000);

  it("fails when a date doesn't reach the pace query (a flat sign-up pace line)", async () => {
    const { runSelfCheck } = await import("./selfCheck.js");
    const demo = new DemoWarehouse();
    const broken = Object.create(demo) as DemoWarehouse;
    broken.enrollmentSummary = async (q, seasons) => {
      const r = await demo.enrollmentSummary(q, seasons);
      const total = r.pace.at(-1)?.current ?? 0;
      return { ...r, pace: r.pace.map((p) => ({ ...p, current: total })) };
    };
    const result = await runSelfCheck(broken, (s, e) => demo.referenceTotals(s, e));
    expect(result.checks.find((c) => c.name === "dates reach the queries")).toMatchObject({ ok: false, detail: expect.stringContaining("flat") });
    // Runs every check against the demo data, like the test above.
  }, 30_000);

  it("catches enrollment totals that disagree with the table", async () => {
    const { runSelfCheck } = await import("./selfCheck.js");
    const demo = new DemoWarehouse();
    const broken = Object.create(demo) as DemoWarehouse;
    broken.enrollmentBreakdown = async (q) => ({ ...(await demo.enrollmentBreakdown(q)), rows: [] });
    const result = await runSelfCheck(broken, (s, e) => demo.referenceTotals(s, e));
    // The School and Parent occupation breakdowns are checked against the same table count.
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["campminder enrollments match tables", "school grouping runs", "parent occupations run"]);
    // Runs every check against the demo data, like the test above.
  }, 30_000);

  it("catches targets revenue that disagrees with the table", async () => {
    const { runSelfCheck } = await import("./selfCheck.js");
    const demo = new DemoWarehouse();
    const broken = Object.create(demo) as DemoWarehouse;
    broken.targetActuals = async (q) => {
      const a = await demo.targetActuals(q);
      return { ...a, revenue: { ...a.revenue, current: a.revenue.current / 2 } };
    };
    const result = await runSelfCheck(broken, (s, e) => demo.referenceTotals(s, e));
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["targets match tables"]);
    // Runs every check against the demo data, like the test above.
  }, 30_000);
});

describe("campminder endpoints", () => {
  it("lists seasons per business line", async () => {
    const res = await request(api()).get("/api/campminder/seasons?businessLine=camp").expect(200);
    expect(res.body.seasons.map((s: { season: number }) => s.season)).toEqual([2026, 2025]);
  });

  it("returns KPIs, weeks and pace with last season as of the same date", async () => {
    const res = await request(api()).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200);
    const b = res.body;
    expect(b.current.enrollments).toBeGreaterThan(0);
    expect(b.current.campers).toBeLessThanOrEqual(b.current.enrollments);
    expect(b.comparison).not.toBeNull();
    expect(b.byWeek.length).toBe(12);
    expect(b.pace.length).toBeGreaterThan(0);
    const last = b.pace[b.pace.length - 1];
    expect(last.current).toBeGreaterThanOrEqual(b.pace[0].current);
  });

  it("breaks down by dimension and keeps grades in school order", async () => {
    const res = await request(api()).get("/api/campminder/breakdown?season=2026&businessLine=camp&dimension=grade").expect(200);
    const keys = res.body.rows.map((r: { key: string }) => r.key);
    expect(keys.indexOf("K")).toBeLessThan(keys.indexOf("1st"));
    expect(keys.indexOf("2nd")).toBeLessThan(keys.indexOf("9th"));
    const groups = await request(api()).get("/api/campminder/breakdown?season=2026&businessLine=chaps&dimension=session_group").expect(200);
    expect(groups.body.rows.map((r: { key: string }) => r.key).sort()).toEqual(["Fall Saddle Club MONDAY", "Spring Group Lessons"]);
  });

  it("drills down with filters that all have to match", async () => {
    const f = encodeURIComponent(JSON.stringify({ program: ["Explorers - Quest"], week: ["9"] }));
    const all = await request(api()).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200);
    const some = await request(api()).get(`/api/campminder/summary?season=2026&businessLine=camp&filters=${f}`).expect(200);
    expect(some.body.current.enrollments).toBeGreaterThan(0);
    expect(some.body.current.enrollments).toBeLessThan(all.body.current.enrollments);
    expect(some.body.byWeek.map((w: { week: number }) => w.week)).toEqual([9]);
    const ages = await request(api()).get(`/api/campminder/breakdown?season=2026&businessLine=camp&dimension=age&filters=${f}`).expect(200);
    const total = ages.body.rows.reduce((s: number, r: { enrollments: number }) => s + r.enrollments, 0);
    expect(total).toBe(some.body.current.enrollments);
    const programs = await request(api()).get(`/api/campminder/breakdown?season=2026&businessLine=camp&dimension=program&filters=${f}`).expect(200);
    expect(programs.body.rows.map((r: { key: string }) => r.key)).toEqual(["Explorers - Quest"]);
  });

  it("breaks down and filters by school, with spellings grouped", async () => {
    const app = api();
    const bySchool = await request(app).get("/api/campminder/breakdown?season=2026&businessLine=camp&dimension=school").expect(200);
    const keys = bySchool.body.rows.map((r: { key: string }) => r.key);
    expect(keys).toContain("The Hilltop School");
    expect(keys).not.toContain("Hilltop");
    const hilltop = bySchool.body.rows.find((r: { key: string }) => r.key === "The Hilltop School");
    const f = encodeURIComponent(JSON.stringify({ school: ["The Hilltop School"] }));
    const some = await request(app).get(`/api/campminder/summary?season=2026&businessLine=camp&filters=${f}`).expect(200);
    expect(some.body.current.enrollments).toBe(hilltop.enrollments);
    // A Settings change regroups right away.
    await request(app).post("/api/settings/schools/actions").send({ action: "assign", spellings: ["RDS"], schoolId: "nces-demo-3" }).expect(200);
    const after = await request(app).get("/api/campminder/breakdown?season=2026&businessLine=camp&dimension=school").expect(200);
    expect(after.body.rows.map((r: { key: string }) => r.key)).not.toContain("RDS");
  });

  it("breaks down and filters by parent occupation, a family counting under each of its fields", async () => {
    const app = api();
    const res = await request(app).get("/api/campminder/breakdown?season=2026&businessLine=camp&dimension=occupation").expect(200);
    const legal = res.body.rows.find((r: { key: string }) => r.key === "Legal");
    expect(legal.campers).toBeGreaterThan(0);
    const all = await request(app).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200);
    const total = res.body.rows.reduce((t: number, r: { campers: number }) => t + r.campers, 0);
    expect(total).toBeGreaterThan(all.body.current.campers);
    const f = encodeURIComponent(JSON.stringify({ occupation: ["Legal"] }));
    const some = await request(app).get(`/api/campminder/summary?season=2026&businessLine=camp&filters=${f}`).expect(200);
    expect(some.body.current.campers).toBe(legal.campers);
  });

  it("sums a season's tuition, payments and balances, by business line", async () => {
    const app = api();
    const all = (await request(app).get("/api/campminder/finance?season=2026").expect(200)).body;
    const camp = (await request(app).get("/api/campminder/finance?season=2026&businessLine=camp").expect(200)).body;
    expect(camp.charges).toBeGreaterThan(0);
    expect(camp.charges).toBeLessThan(all.charges);
    expect(camp.netTuition).toBeCloseTo(camp.charges - camp.discounts, 2);
    expect(camp.netCollected).toBeCloseTo(camp.payments - camp.refunds, 2);
    // What's owed less credit held is everything charged less everything paid.
    expect(camp.balanceOwed - camp.creditHeld).toBeCloseTo(camp.netTuition - camp.netCollected, 2);
    expect(camp.householdsOwing).toBeGreaterThan(0);
    expect(camp.householdsOwing).toBeLessThan(camp.households);
    await request(app).get("/api/campminder/finance?season=abc").expect(400);
    expect(camp.filtered).toBe(false);
  });

  it("reports camp extras by item, week and session, against last season at the same point", async () => {
    const app = api();
    const x = (await request(app).get("/api/campminder/extras?season=2026&businessLine=camp").expect(200)).body as CampminderExtras;
    const names = x.items.map((i) => i.item);
    // Automatic until chosen: lunches, gear and camp cancellation fees, all Summer Camp items.
    expect(names.sort()).toEqual(["Backpack", "Gear Bag", "Lunch", "Summer Camp Cancellation Fee"]);
    // Tuition isn't an extra, and nothing Miscellaneous is.
    expect(names.some((n) => /Farm|Airline/.test(n))).toBe(false);
    const lunch = x.items.find((i) => i.item === "Lunch")!;
    const lunchRows = x.bySession.filter((r) => r.item === "Lunch");
    expect(lunchRows.every((r) => r.week !== null && r.sessionGroup)).toBe(true);
    expect(lunchRows.reduce((t, r) => t + r.count, 0)).toBe(lunch.count);
    expect(lunch.revenue).toBeCloseTo(lunch.count * 45, 2);
    expect(lunch.lastCount).toBeGreaterThan(0);
    expect(x.lastSeasonCutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Extras show in the financial report too, by item.
    const byItem = (await request(app).post("/api/reports/run").send({ spec: { dataset: "campminder_finance", rows: ["item_group"], measure: "items_sold", filters: { season: ["2026"], business_line: ["camp"] } } }).expect(200))
      .body;
    expect(byItem.cells.find((c: { rows: string[] }) => c.rows[0] === "Lunch").value).toBe(lunch.count);
    await request(app).get("/api/campminder/extras?season=x").expect(400);

    // Settings lists every Summer Camp line item (tuition too) to choose from; choosing replaces the automatic set.
    const choices = (await request(app).get("/api/campminder/camp-items").expect(200)).body;
    expect(choices.automatic).toBe(true);
    expect(choices.items.map((i: { item: string }) => i.item)).toEqual(expect.arrayContaining(["Lunch", "Gear Bag"]));
    expect(choices.items.some((i: { item: string }) => i.item === "Airline Charge")).toBe(false);
    const settings = (await request(app).get("/api/settings/seasons")).body;
    await request(app).put("/api/settings/seasons").send({ ...settings, campExtras: ["Lunch"] }).expect(200);
    const chosen = (await request(app).get("/api/campminder/extras?season=2026&businessLine=camp").expect(200)).body as CampminderExtras;
    expect(chosen.items.map((i) => i.item)).toEqual(["Lunch"]);
    expect((await request(app).get("/api/campminder/camp-items")).body).toMatchObject({ automatic: false, extras: ["Lunch"] });

    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; types: Record<string, unknown> }> = [];
    const fake = { query: async (o: { query: string; types: Record<string, unknown> }) => (calls.push(o), [[]]) };
    await new BigQueryWarehouse(fake as never, "marts").campminderExtras({ season: 2026 }, "2025-11-18", ["Lunch"]);
    expect(calls[0]!.query).toContain("category = @category");
    expect(calls[0]!.query).toContain("item_group IN UNNEST(@items)");
    expect(calls[0]!.query).toContain("CAST(@cutoff AS DATE)");
    expect(calls[0]!.types).toMatchObject({ cutoff: "STRING", items: ["STRING"] });
  });

  it("narrows tuition to the camper-sessions the Camp page filters match", async () => {
    const app = api();
    const get = async (f: object) =>
      (await request(app).get(`/api/campminder/finance?season=2026&businessLine=camp&filters=${encodeURIComponent(JSON.stringify(f))}`).expect(200)).body;
    const all = await get({});
    const farm = await get({ session_group: ["Farm"] });
    const riley = await get({ session_group: ["Riley's"] });
    expect(farm.filtered).toBe(true);
    // A camper in both Farm and Riley's counts only the Farm sessions under Farm.
    expect(farm.charges).toBeGreaterThan(0);
    expect(farm.charges + riley.charges).toBeLessThanOrEqual(all.charges);
    // Every camp camper-session is in some group: the groups' charges add up to the whole.
    const groups = ["Farm", "Riley's", "Madeira", "Fraser"];
    let sum = 0;
    for (const g of groups) sum += (await get({ session_group: [g] })).charges;
    expect(sum).toBeCloseTo(all.charges, 2);
    // A camper filter keeps all of a matching camper's sessions.
    const girls = await get({ gender: ["Female"] });
    const boys = await get({ gender: ["Male"] });
    expect(girls.charges + boys.charges).toBeCloseTo(all.charges, 2);
  });

  it("counts families and siblings on the Camp pages, with a Campers in family breakdown and filter", async () => {
    const app = api();
    const s = (await request(app).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200)).body;
    expect(s.current.families).toBeGreaterThan(0);
    expect(s.current.siblingFamilies).toBeGreaterThan(0);
    expect(s.current.siblingFamilies).toBeLessThan(s.current.families);
    expect(s.current.siblingWeeksTogether).toBeGreaterThan(0);
    expect(s.comparison.families).toBeGreaterThan(0);
    const b = (await request(app).get("/api/campminder/breakdown?season=2026&businessLine=camp&dimension=family").expect(200)).body;
    const keys = b.rows.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["1 camper", "2 campers"]));
    const two = b.rows.find((r: { key: string }) => r.key === "2 campers");
    const f = encodeURIComponent(JSON.stringify({ family: ["2 campers"] }));
    const only = (await request(app).get(`/api/campminder/summary?season=2026&businessLine=camp&filters=${f}`).expect(200)).body;
    expect(only.current.campers).toBe(two.campers);
    expect(only.current.siblingFamilies).toBe(only.current.families);
  });

  it("counts sign-ups by days since each family's registration wave opened", async () => {
    const app = api();
    const pace = (await request(app).get("/api/campminder/registration-pace?businessLine=camp").expect(200)).body.rows as Array<{
      season: number; wave: string; day: number; enrollments: number; campers: number;
    }>;
    const s26 = pace.filter((r) => r.season === 2026);
    expect(new Set(s26.map((r) => r.wave))).toEqual(new Set(["va", "md", "new"]));
    expect(s26.every((r) => r.day >= -1)).toBe(true);
    expect(s26.some((r) => r.day === -1)).toBe(true);
    // Every enrolled camper-session counts in exactly one wave.
    const summary = (await request(app).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200)).body;
    expect(s26.reduce((t, r) => t + r.enrollments, 0)).toBe(summary.current.enrollments);
    // Without camp locations no family is returning: everyone is in the new-families wave.
    const settings = (await request(app).get("/api/settings/seasons").expect(200)).body;
    expect(settings.registration.opens["2026"]).toEqual({ va: "2026-01-06", md: "2026-01-08", new: "2026-01-12" });
    await request(app).put("/api/settings/seasons").send({ ...settings, registration: { ...settings.registration, locations: {} } }).expect(200);
    const allNew = (await request(app).get("/api/campminder/registration-pace?businessLine=camp").expect(200)).body.rows;
    expect(new Set(allNew.map((r: { wave: string }) => r.wave))).toEqual(new Set(["new"]));
    await request(app).put("/api/settings/seasons").send({ ...settings, registration: { ...settings.registration, locations: { Farm: "pa" } } }).expect(400);
  });

  it("maps homes with the same filters", async () => {
    const all = await request(api()).get("/api/campminder/map?season=2026&businessLine=camp").expect(200);
    const f = encodeURIComponent(JSON.stringify({ week: ["9"], program: ["Rock Climbing with THURSDAY CAMPOUT"] }));
    const some = await request(api()).get(`/api/campminder/map?season=2026&businessLine=camp&filters=${f}`).expect(200);
    expect(all.body.points.length).toBeGreaterThan(some.body.points.length);
    expect(some.body.points.length).toBeGreaterThan(0);
    expect(all.body.unplaced).toBeGreaterThan(0);
    for (const p of all.body.points) {
      expect(Object.keys(p).sort()).toEqual(["campers", "enrollments", "lat", "lon"]);
      expect(p.lat).toBeGreaterThan(38.5);
    }
    const { mapSql } = await import("./warehouse/campminderSql.js");
    expect(mapSql("t")).toContain("status_code = 'EN'");
  });

  it("validates input", async () => {
    await request(api()).get("/api/campminder/summary?season=abc").expect(400);
    await request(api()).get("/api/campminder/summary?season=2026&filters=notjson").expect(400);
    await request(api()).get(`/api/campminder/summary?season=2026&filters=${encodeURIComponent('{"name":["x"]}')}`).expect(400);
    await request(api()).get("/api/campminder/breakdown?season=2026&dimension=name").expect(400);
    await request(api()).get("/api/campminder/seasons?businessLine=nope").expect(400);
  });

  it("only interpolates fixed SQL fragments", async () => {
    const sql = await import("./warehouse/campminderSql.js");
    for (const s of [sql.seasonsSql("t"), sql.kpiSql("t"), sql.byWeekSql("t"), sql.paceSql("t"), sql.breakdownSql("t", "grade")]) {
      expect(s).toContain("@business_line IS NULL");
      expect(s).not.toMatch(/\b(WITH|FROM|AS)\s+rows\b/i);
    }
    const { params, types } = sql.drillParams({ week: ["9"] });
    const t = sql.enrollmentsWithSchools("t"); // the school grouping reads @schools
    for (const s of [sql.kpiSql(t), sql.byWeekSql(t), sql.paceSql(t), sql.breakdownSql(t, "age"), sql.mapSql(t)]) {
      for (const p of Object.keys(params)) expect(s).toContain(`@${p}`);
    }
    expect(params.f_week).toEqual(["9"]);
    expect(params.f_program).toEqual([]);
    expect(types.f_program).toEqual(["STRING"]);
  });
});

describe("report builder", () => {
  const run = (app: ReturnType<typeof api>, spec: object) => request(app).post("/api/reports/run").send({ spec });

  it("runs every starter report", async () => {
    const app = api();
    const list = await request(app).get("/api/reports").expect(200);
    const starters = list.body.reports.filter((r: { starter: boolean }) => r.starter);
    expect(starters.length).toBeGreaterThanOrEqual(4);
    for (const r of starters) {
      const res = await run(app, r.spec).expect(200);
      expect(res.body.cells.some((c: { kind: string }) => c.kind === "cell")).toBe(true);
      expect(r.canEdit).toBe(false);
    }
  });

  it("counts distinct campers correctly in totals", async () => {
    const res = await run(api(), { dataset: "enrollments", rows: ["session_group"], measure: "campers", filters: { season: ["2026"], business_line: ["camp"] } }).expect(200);
    const cells = res.body.cells.filter((c: { kind: string }) => c.kind === "cell");
    const total = res.body.cells.find((c: { kind: string }) => c.kind === "total").value;
    const sum = cells.reduce((t: number, c: { value: number }) => t + c.value, 0);
    // Campers in several session groups count once in the total.
    expect(total).toBeLessThan(sum);
    expect(total).toBeGreaterThan(0);
  });

  it("answers the example questions", async () => {
    const app = api();
    const years = await run(app, { dataset: "camper_seasons", rows: ["years_at_camp"], measure: "avg_sessions", filters: { business_line: ["camp"] } }).expect(200);
    expect(years.body.cells.filter((c: { kind: string }) => c.kind === "cell").length).toBeGreaterThan(3);
    const branches = await run(app, { dataset: "program_families", rows: ["branch_combination"], measure: "campers", filters: { program_family: ["Explorers"] } }).expect(200);
    const combos = branches.body.cells.filter((c: { kind: string }) => c.kind === "cell").map((c: { rows: string[] }) => c.rows[0]);
    expect(combos).toContain("Critters and Creatures");
    expect(combos.some((c: string) => c.includes(" + "))).toBe(true);
    const zip = await run(app, { dataset: "enrollments", rows: ["zip"], column: "week", measure: "enrollments", filters: { zip: ["20016"] }, percent: "row" }).expect(200);
    const kinds = new Set(zip.body.cells.map((c: { kind: string }) => c.kind));
    expect([...kinds].sort()).toEqual(["cell", "column_total", "row_total", "total"]);
    const ret = await run(app, { dataset: "camper_seasons", rows: ["season"], measure: "return_rate" }).expect(200);
    const s2025 = ret.body.cells.find((c: { rows: string[]; kind: string }) => c.kind === "cell" && c.rows[0] === "2025");
    expect(s2025.value).toBeGreaterThan(0);
    expect(s2025.value).toBeLessThan(1);
  });

  it("rejects specs outside the vetted fields and measures", async () => {
    const app = api();
    await run(app, { dataset: "enrollments", rows: ["camper_name"], measure: "campers" }).expect(400);
    await run(app, { dataset: "camper_seasons", rows: ["age"], measure: "avg_sessions", percent: "row" }).expect(400);
    await run(app, { dataset: "revenue", rows: ["month"], measure: "net" }).expect(400);
    await run(app, { dataset: "enrollments", rows: ["age"], column: "age", measure: "campers" }).expect(400);
  });

  it("only ever passes filter values as parameters", async () => {
    const { compileReport } = await import("./warehouse/reportSql.js");
    const evil = "x'); DROP TABLE marts.y; --";
    const { sql, params } = compileReport(
      reportSpecSchema.parse({
        dataset: "store_sales",
        rows: ["item"],
        column: "month",
        measure: "net",
        filters: { category: [evil] },
        exclude: { item: [evil] },
        start: "2026-01-01",
        end: "2026-01-31",
      }),
      "marts",
      { overrides: {} },
    );
    expect(sql).not.toContain("DROP");
    expect(params.f0).toEqual([evil]);
    expect(params.x0).toEqual([evil]);
    expect(sql).toContain("GROUPING SETS ((r0, c), (r0), (c), ())");
  });

  it("splits campers by parent occupation only when a report asks for it", async () => {
    const { compileReport } = await import("./warehouse/reportSql.js");
    const base = { dataset: "camper_seasons", column: "season", measure: "campers" } as const;
    expect(compileReport(reportSpecSchema.parse({ ...base, rows: ["age"] }), "marts", { overrides: {} }).sql).not.toContain("mv_parent_occupation");
    expect(compileReport(reportSpecSchema.parse({ ...base, rows: ["parent_occupation"] }), "marts", { overrides: {} }).sql).toContain("AS mv_parent_occupation");
    const res = await run(api(), { dataset: "camper_seasons", rows: ["parent_occupation"], measure: "campers" }).expect(200);
    expect(res.body.cells.map((c: { rows: string[] }) => c.rows[0])).toEqual(expect.arrayContaining(["Legal", "Medicine and health"]));
  });

  it("reports on campers by the session groups, sessions and programs they attended", async () => {
    const app = api();
    const cell = (body: { cells: Array<{ kind: string; rows: string[]; value: number }> }, row?: string) =>
      body.cells.find((c) => (row ? c.kind === "cell" && c.rows[0] === row : c.kind === "total"))!.value;
    const base = { dataset: "camper_seasons", filters: { season: ["2026"], business_line: ["camp"] } };
    // Campers with at least one Farm session, and their sessions across the whole season (Farm or not).
    const farm = { ...base, filters: { ...base.filters, session_group: ["Farm"] } };
    const farmCampers = cell((await run(app, { ...farm, measure: "campers" }).expect(200)).body);
    const farmSessions = cell((await run(app, { ...farm, measure: "sessions_total" }).expect(200)).body);
    const farmAvg = cell((await run(app, { ...farm, measure: "avg_sessions" }).expect(200)).body);
    expect(farmAvg).toBeCloseTo(farmSessions / farmCampers, 3);
    const enrolledInFarm = cell((await run(app, { dataset: "enrollments", rows: ["session_group"], measure: "campers", filters: base.filters }).expect(200)).body, "Farm");
    expect(farmCampers).toBe(enrolledInFarm);
    // Their sessions include other groups too.
    const farmOnly = cell((await run(app, { dataset: "enrollments", measure: "enrollments", filters: { ...base.filters, session_group: ["Farm"] } }).expect(200)).body);
    expect(farmSessions).toBeGreaterThan(farmOnly);
    // As rows, each group shows its campers, and the distribution of sessions per camper works under a filter.
    const byGroup = (await run(app, { ...base, rows: ["session_group"], measure: "avg_sessions" }).expect(200)).body;
    expect(cell(byGroup, "Farm")).toBeCloseTo(farmAvg, 3);
    const dist = (await run(app, { ...farm, rows: ["sessions"], measure: "campers" }).expect(200)).body;
    expect(cell(dist)).toBe(farmCampers);
    // Two weeks chosen: campers at camp in either, each counted once.
    const weeks = { ...base, filters: { ...base.filters, week: ["3", "4"] } };
    const either = cell((await run(app, { ...weeks, measure: "campers" }).expect(200)).body);
    expect(cell((await run(app, { ...weeks, measure: "sessions_total" }).expect(200)).body) / either).toBeCloseTo(
      cell((await run(app, { ...weeks, measure: "avg_sessions" }).expect(200)).body),
      3,
    );
  });

  it("answers the follow-up questions: sessions in a group, exclusions, sign-up timing, same-group returns, other lines, cancellations", async () => {
    const app = api();
    const total = async (spec: object) => (await run(app, spec).expect(200)).body.cells.find((c: { kind: string }) => c.kind === "total").value as number;
    const camp = { season: ["2026"], business_line: ["camp"] };
    const cs = (measure: string, filters: object = {}, exclude: object = {}) => ({ dataset: "camper_seasons", measure, filters: { ...camp, ...filters }, exclude });

    // Sessions in the chosen group: Farm campers' Farm sessions, as counted in Enrollments.
    const farmSessions = await total({ dataset: "enrollments", measure: "enrollments", filters: { ...camp, session_group: ["Farm"] } });
    expect(await total(cs("sessions_matching", { session_group: ["Farm"] }))).toBe(farmSessions);
    expect(await total(cs("sessions_matching"))).toBe(await total(cs("sessions_total")));
    const byGroup = (await run(app, { ...cs("sessions_matching"), rows: ["session_group"] }).expect(200)).body;
    expect(byGroup.cells.find((c: { kind: string; rows: string[] }) => c.kind === "cell" && c.rows[0] === "Farm").value).toBe(farmSessions);

    // Exclusions: campers who did Riley's plus those who didn't are all campers.
    const all = await total(cs("campers"));
    const riley = await total(cs("campers", { session_group: ["Riley's"] }));
    const notRiley = await total(cs("campers", {}, { session_group: ["Riley's"] }));
    expect(riley + notRiley).toBe(all);
    expect(await total({ dataset: "enrollments", measure: "enrollments", filters: camp, exclude: { gender: ["Male"] } })).toBe(
      await total({ dataset: "enrollments", measure: "enrollments", filters: { ...camp, gender: ["Female"] } }),
    );

    // Sign-up timing.
    const months = (await run(app, { dataset: "enrollments", rows: ["signup_month"], measure: "enrollments", filters: camp }).expect(200)).body;
    expect(months.cells.some((c: { rows: string[] }) => /^\d{4}-\d{2}$/.test(c.rows[0] ?? ""))).toBe(true);
    const lead = (await run(app, { dataset: "enrollments", rows: ["weeks_before_session"], measure: "enrollments", filters: camp }).expect(200)).body;
    expect(lead.cells.filter((c: { kind: string }) => c.kind === "cell").length).toBeGreaterThan(5);

    // Coming back to the same group is never more common than coming back at all.
    const last = { season: ["2025"], business_line: ["camp"] };
    const back = await total({ dataset: "camper_seasons", measure: "return_rate", filters: last });
    const same = await total({ dataset: "camper_seasons", measure: "return_rate_same_group", filters: last });
    expect(same).toBeGreaterThan(0);
    expect(same).toBeLessThanOrEqual(back);

    // Other business lines the same season, and cancellations among enrolled campers.
    const lines = (await run(app, { ...cs("campers"), rows: ["also_business_line"] }).expect(200)).body;
    expect(lines.cells.map((c: { rows: string[] }) => c.rows[0])).toEqual(expect.arrayContaining(["(none)", "school_year"]));
    const rate = await total(cs("cancel_rate"));
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(1);
    const cancelledSessions = await total(cs("cancelled_sessions"));
    const allCancelled = await total({ dataset: "enrollments", measure: "cancelled", filters: camp }) + (await total({ dataset: "enrollments", measure: "withdrawn", filters: camp }));
    expect(cancelledSessions).toBeGreaterThan(0);
    expect(cancelledSessions).toBeLessThanOrEqual(allCancelled);

    // Change from the previous column needs an ordered column.
    await run(app, { ...cs("campers"), rows: ["age"], column: "gender", change: "percent" }).expect(400);
    await run(app, { dataset: "camper_seasons", measure: "campers", rows: ["age"], column: "season", change: "percent" }).expect(200);
  });

  it("splits multi-valued fields only for rows and columns, and filters on them with EXISTS", async () => {
    const { compileReport } = await import("./warehouse/reportSql.js");
    const spec = (s: object) => reportSpecSchema.parse({ dataset: "camper_seasons", measure: "avg_sessions", ...s });
    const filtered = compileReport(spec({ filters: { session_group: ["Farm"] } }), "marts", { overrides: {} }).sql;
    expect(filtered).toContain("EXISTS (SELECT 1 FROM UNNEST(IF(ARRAY_LENGTH(attended_session_groups)");
    expect(filtered).not.toContain("mv_session_group");
    const rows = compileReport(spec({ rows: ["session_group"], column: "parent_occupation" }), "marts", { overrides: {} }).sql;
    expect(rows).toContain("AS mv_session_group");
    expect(rows).toContain("AS mv_parent_occupation");
    expect(rows).toContain("x.session_group = mv_session_group");
    expect(filtered).toContain("COALESCE(x.session_group, '(none)') IN UNNEST(@f0)");
    const excluded = compileReport(spec({ exclude: { session_group: ["Riley's"] } }), "marts", { overrides: {} });
    expect(excluded.sql).toContain("NOT EXISTS (SELECT 1 FROM UNNEST(IF(ARRAY_LENGTH(attended_session_groups)");
    expect(excluded.params.x0).toEqual(["Riley's"]);
  });

  it("reports on Campminder financials, agreeing with the season summary", async () => {
    const app = api();
    const total = async (measure: string, filters: object = { season: ["2026"], business_line: ["camp"] }) =>
      (await run(app, { dataset: "campminder_finance", measure, filters }).expect(200)).body.cells.find((c: { kind: string }) => c.kind === "total").value as number;
    const summary = (await request(app).get("/api/campminder/finance?season=2026&businessLine=camp").expect(200)).body;
    expect(await total("net_tuition")).toBeCloseTo(summary.netTuition, 0);
    expect(await total("net_collected")).toBeCloseTo(summary.netCollected, 0);
    expect(await total("balance_owed")).toBeCloseTo(summary.balanceOwed, 0);
    expect(await total("households_owing")).toBe(summary.householdsOwing);
    const byType = (await run(app, { dataset: "campminder_finance", rows: ["type"], measure: "balance", filters: { season: ["2026"] } }).expect(200)).body;
    expect(byType.cells.map((c: { rows: string[] }) => c.rows[0])).toEqual(expect.arrayContaining(["Charge", "Payment", "Refund", "Discount or credit"]));

    const { compileReport } = await import("./warehouse/reportSql.js");
    const { sql, params } = compileReport(reportSpecSchema.parse({ dataset: "campminder_finance", rows: ["program_family"], measure: "balance_owed" }), "marts", { overrides: {} });
    expect(sql).toContain("marts.fct_campminder_transactions");
    expect(sql).toContain("PARTITION BY t.family_hash, t.season, t.business_line");
    expect(params).toHaveProperty("pf");
    expect(params).not.toHaveProperty("schools");
  });

  it("reports on families: siblings, weeks together, change from last season", async () => {
    const app = api();
    const total = async (spec: object) =>
      (await run(app, spec).expect(200)).body.cells.find((c: { kind: string }) => c.kind === "total").value as number;
    const camp26 = { season: ["2026"], business_line: ["camp"] };
    const summary = (await request(app).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200)).body.current;
    expect(await total({ dataset: "families", measure: "families", filters: camp26 })).toBe(summary.families);
    expect(await total({ dataset: "families", measure: "sibling_families", filters: camp26 })).toBe(summary.siblingFamilies);
    expect(await total({ dataset: "families", measure: "campers", filters: camp26 })).toBe(summary.campers);
    expect(await total({ dataset: "families", measure: "weeks_together", filters: camp26 })).toBe(summary.siblingWeeksTogether);
    const change = (await run(app, { dataset: "families", rows: ["change_vs_last"], column: "season", measure: "families", filters: { business_line: ["camp"] } }).expect(200)).body;
    const cells = change.cells.filter((c: { kind: string }) => c.kind === "cell");
    expect(cells.filter((c: { column: string }) => c.column === "2026").map((c: { rows: string[] }) => c.rows[0])).toEqual(
      expect.arrayContaining(["New family", "Same number"]),
    );
    // The first season with data has nothing to compare with.
    expect(cells.filter((c: { column: string }) => c.column === "2025").map((c: { rows: string[] }) => c.rows[0])).toEqual(["(none)"]);
    // Campers in family on the camper data sets agrees with the families' own count.
    const campersWithSiblings = await total({ dataset: "camper_seasons", measure: "campers", filters: { ...camp26, campers_in_family: ["2 campers", "3 campers", "4+ campers"] } });
    expect(campersWithSiblings).toBe(await total({ dataset: "families", measure: "campers_in_sibling_families", filters: camp26 }));

    const { compileReport } = await import("./warehouse/reportSql.js");
    const { sql } = compileReport(reportSpecSchema.parse({ dataset: "families", rows: ["week"], measure: "pct_together" }), "marts", { overrides: {} });
    expect(sql).toContain("HAVING COUNT(DISTINCT camper_hash) >= 2");
    expect(sql).toContain("AS mv_week");
  });

  it("lists filter values with counts", async () => {
    const res = await request(api()).post("/api/reports/values").send({ spec: { dataset: "enrollments", measure: "campers" }, field: "program_family" }).expect(200);
    expect(res.body.values.map((v: { value: string }) => v.value)).toContain("Explorers");
  });

  it("keeps private reports private and lets only owners change them", async () => {
    const people: AuthDeps = {
      allowedDomains: ["calleva.org"],
      loadAccessList: async () => ({ allowedEmails: [], admins: ["boss@calleva.org"] }),
      verifyIdToken: async (t) => ({ ...org, email: `${t}@calleva.org` }),
    };
    const app = api(people);
    const as = (who: string) => ({ Authorization: `Bearer ${who}` });
    const spec = { dataset: "enrollments", rows: ["age"], measure: "campers" };
    const mine = await request(app).post("/api/reports").set(as("pat")).send({ name: "Ages", spec }).expect(201);
    const list = (who: string) => request(app).get("/api/reports").set(as(who)).then((r) => r.body.reports.map((x: { id: string }) => x.id));
    expect(await list("pat")).toContain(mine.body.id);
    expect(await list("sam")).not.toContain(mine.body.id);
    await request(app).put(`/api/reports/${mine.body.id}`).set(as("pat")).send({ name: "Ages", spec, shared: true }).expect(200);
    expect(await list("sam")).toContain(mine.body.id);
    await request(app).put(`/api/reports/${mine.body.id}`).set(as("sam")).send({ name: "Mine now", spec }).expect(403);
    await request(app).delete(`/api/reports/${mine.body.id}`).set(as("sam")).expect(403);
    await request(app).delete(`/api/reports/${mine.body.id}`).set(as("boss")).expect(200);
  });

  it("applies program family settings", async () => {
    const app = api();
    const before = await request(app).get("/api/settings/program-families").expect(200);
    expect(before.body.programs.find((p: { program: string }) => p.program === "Explorers - Quest")).toMatchObject({ family: "Explorers", branch: "Quest", origin: "draft" });
    await request(app)
      .put("/api/settings/program-families")
      .send({ overrides: { "Riley's Water Sampler": { family: "Water", branch: "Sampler" } } })
      .expect(200);
    const res = await run(app, { dataset: "enrollments", rows: ["program_family"], measure: "enrollments" }).expect(200);
    expect(res.body.cells.map((c: { rows: string[] }) => c.rows[0])).toContain("Water");
  });

  it("matches school spellings to actual schools, and Settings → Schools settles the rest", async () => {
    const app = api();
    const get = async () => (await request(app).get("/api/settings/schools").expect(200)).body;
    const before = await get();
    const school = (body: { schools: Array<{ id: string; name: string; spellings: Array<{ entered: string; status: string }> }> }, id: string) =>
      body.schools.find((s) => s.id === id);
    // Spellings of directory schools are matched automatically.
    expect(school(before, "nces-demo-2")!.spellings.map((s) => s.entered).sort()).toEqual(["Hilltop", "Hilltop School", "The Hilltop School"]);
    // Schools that aren't in the directory wait for review, grouped with their look-alikes.
    const brigid = before.review.find((r: { name: string }) => r.name === "St. Brigid's");
    expect(brigid.spellings.map((s: { entered: string }) => s.entered).sort()).toEqual(["Saint Brigid's School", "St Brigids", "St. Brigid's"]);
    expect(before.notSchools.map((s: { entered: string }) => s.entered)).toContain("N/A");

    const schools = async () =>
      (await run(app, { dataset: "camper_seasons", rows: ["school"], measure: "campers" }).expect(200)).body.cells.map((c: { rows: string[] }) => c.rows[0]);
    expect(await schools()).toContain("The Hilltop School");
    expect(await schools()).not.toContain("Hilltop");

    // Create a school for the review item; reports use it right away.
    await request(app)
      .post("/api/settings/schools/actions")
      .send({ action: "create", spellings: brigid.spellings.map((s: { entered: string }) => s.entered), school: { name: "St. Brigid School", type: "private", state: "MD", county: "Montgomery County" } })
      .expect(200);
    const after = await get();
    expect(after.review.find((r: { name: string }) => r.name === "St. Brigid's")).toBeUndefined();
    expect(after.schools.find((s: { name: string }) => s.name === "St. Brigid School").source).toBe("custom");
    expect(await schools()).toContain("St. Brigid School");

    // Type, state and county come along for reports.
    const byCounty = await run(app, { dataset: "camper_seasons", rows: ["school_county"], column: "school_type", measure: "campers" }).expect(200);
    const counties = byCounty.body.cells.map((c: { rows: string[] }) => c.rows[0]);
    expect(counties).toEqual(expect.arrayContaining(["Montgomery County", "Arlington County"]));

    // Assigning to a school that doesn't exist is refused; search finds schools by any spelling.
    await request(app).post("/api/settings/schools/actions").send({ action: "assign", spellings: ["RDS"], schoolId: "nope" }).expect(400);
    const found = await request(app).get("/api/settings/schools/search?q=riverbend").expect(200);
    expect(found.body.results[0]).toMatchObject({ id: "nces-demo-3", name: "Riverbend Day School" });
  });
});

describe("fareharbor days", () => {
  it("returns this and last season's nights with closures and the same-point cutoff", async () => {
    const app = api();
    const res = await request(app).get("/api/fareharbor/days?businessLine=haunted_forest&season=2026").expect(200);
    expect(res.body).toMatchObject({ businessLine: "haunted_forest", season: 2026, nightly: true });
    expect(res.body.previous.end < res.body.current.start).toBe(true);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.rows.some((r: { day: string }) => r.day.startsWith("2025-10"))).toBe(true);
    expect(res.body.closures.map((c: { date: string }) => c.date)).toContain("2026-10-11");
    expect(res.body.seasons).toContain(2026);
  });

  it("groups other lines by week and rejects unknown lines", async () => {
    const app = api();
    const res = await request(app).get("/api/fareharbor/days?businessLine=river_school&season=2026").expect(200);
    expect(res.body.nightly).toBe(false);
    expect(res.body.rows.every((r: { day: string }) => new Date(`${r.day}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    await request(app).get("/api/fareharbor/days?businessLine=nope").expect(400);
  });
});

describe("hubspot deals", () => {
  it("returns the open pipeline and won deals for a line", async () => {
    const res = await request(api()).get("/api/hubspot/deals?businessLine=education").expect(200);
    expect(res.body.businessLine).toBe("education");
    expect(res.body.open.length).toBeGreaterThan(0);
    expect(res.body.won.length).toBe(24);
    await request(api()).get("/api/hubspot/deals?businessLine=nope").expect(400);
  });
});

describe("hubspot programs", () => {
  it("returns this and last season's programs with roles guessed from property labels", async () => {
    const res = await request(api()).get("/api/hubspot/programs?businessLine=education&season=2026").expect(200);
    expect(res.body.season).toBe(2026);
    const names = (r: string) => res.body.roles[r].map((p: { name: string }) => p.name);
    expect(names("participants")).toEqual(["number_of_participants"]);
    // Free + paid chaperones are both used (added up).
    expect(names("chaperones")).toEqual(["free_chaperone_count", "paid_chaperone_count"]);
    expect(names("programType")).toEqual(["program_type"]);
    expect(names("food")).toEqual(["food_service"]);
    expect(names("transportation")).toEqual(["transportation"]);
    expect(res.body.programs.some((r: { period: string }) => r.period === "previous")).toBe(true);
    expect(res.body.lineItems.length).toBeGreaterThan(0);
    const props = await request(api()).get("/api/hubspot/properties").expect(200);
    expect(props.body.properties.length).toBeGreaterThan(3);
  });
});

describe("targets", () => {
  const thisYear = Number(new Date().toISOString().slice(0, 4));
  it("saves targets (admins only) and keeps only measures a line can have", async () => {
    const app = api();
    expect((await request(app).get("/api/settings/targets").expect(200)).body).toEqual({ seasons: {} });
    const body = { seasons: { [thisYear]: { camp: { revenue: 1000, guests: 5 }, farm_store: { revenue: 200 } } } };
    await request(app).put("/api/settings/targets").send({ seasons: { [thisYear]: { camp: { revenue: -1 } } } }).expect(400);
    const saved = (await request(app).put("/api/settings/targets").send(body).expect(200)).body;
    expect(saved).toEqual({ seasons: { [thisYear]: { camp: { revenue: 1000 }, farm_store: { revenue: 200 } } } });
    expect((await request(app).get("/api/settings/targets")).body).toEqual(saved);
  });

  it("refuses target changes from non-admins", async () => {
    const auth: AuthDeps = {
      allowedDomains: ["calleva.org"],
      loadAccessList: async () => ({ allowedEmails: [], admins: ["boss@calleva.org"] }),
      verifyIdToken: async () => org,
    };
    await request(api(auth)).put("/api/settings/targets").set("Authorization", "Bearer t").send({ seasons: {} }).expect(403);
  });

  it("reports progress against each target with last season's pace", async () => {
    const app = api();
    const none = (await request(app).get("/api/targets/progress?businessLine=camp").expect(200)).body;
    expect(none).toMatchObject({ season: null, seasons: [], rows: [] });
    await request(app)
      .put("/api/settings/targets")
      .send({ seasons: { [thisYear]: { farm_store: { revenue: 900_000 } }, [thisYear - 1]: { camp: { revenue: 1_000_000, campers: 500 } } } })
      .expect(200);
    const fs = (await request(app).get("/api/targets/progress?businessLine=farm_store").expect(200)).body;
    expect(fs).toMatchObject({ season: thisYear, seasons: [thisYear], ended: false, alignedBy: "date", range: { start: `${thisYear}-01-01`, end: `${thisYear}-12-31` } });
    const row = fs.rows[0];
    expect(row).toMatchObject({ measure: "revenue", target: 900_000 });
    expect(row.actual).toBeGreaterThan(0);
    expect(row.expected).toBeGreaterThan(0);
    expect(row.expected).toBeLessThanOrEqual(900_000);
    expect(["ahead", "on_track", "behind"]).toContain(row.status);
    // A finished season: expected is the whole target, and it was reached or missed.
    const camp = (await request(app).get(`/api/targets/progress?businessLine=camp&season=${thisYear - 1}`).expect(200)).body;
    expect(camp.ended).toBe(true);
    expect(camp.rows.map((r: { measure: string }) => r.measure)).toEqual(["revenue", "campers"]);
    for (const r of camp.rows) {
      expect(r.expected).toBe(r.target);
      expect(["reached", "missed"]).toContain(r.status);
    }
    await request(app).get("/api/targets/progress?businessLine=nowhere").expect(400);
  });

  it("moves on to next season's targets once last season's pace is complete", async () => {
    const app = api();
    await request(app)
      .put("/api/settings/targets")
      .send({ seasons: { [thisYear]: { farm_store: { revenue: 900_000 } }, [thisYear + 1]: { farm_store: { revenue: 950_000 } } } })
      .expect(200);
    const now = (await request(app).get(`/api/targets/progress?businessLine=farm_store&season=${thisYear}`).expect(200)).body;
    const done = now.rows.every((r: { expected: number | null; target: number }) => r.expected !== null && r.expected >= r.target);
    const auto = (await request(app).get("/api/targets/progress?businessLine=farm_store").expect(200)).body;
    expect(auto.season).toBe(done ? thisYear + 1 : thisYear);
    expect(auto.seasons).toEqual([thisYear + 1, thisYear]);
    await request(app).get(`/api/targets/progress?businessLine=farm_store&season=1999`).expect(400);
    expect((await request(app).get(`/api/targets/progress?businessLine=farm_store&season=2030`).expect(200)).body.season).toBeNull();
  });

  it("passes dates as text and the participant properties as a list", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; types: Record<string, unknown> }> = [];
    const fake = {
      query: async (o: { query: string; types: Record<string, unknown> }) => (
        calls.push(o), [[{ measure: "revenue", cur_total: "10.005", prev_sp: 4, prev_final: 8 }, { measure: "campers", cur_total: 3, prev_sp: 1, prev_final: 2 }]]
      ),
    };
    const a = await new BigQueryWarehouse(fake as never, "marts").targetActuals({
      businessLine: "camp",
      season: 2027,
      current: { start: "2027-01-01", end: "2027-12-31" },
      previous: { start: "2026-01-01", end: "2026-12-31" },
      cutoff: "2026-01-20",
      participantProps: ["participants"],
    });
    expect(a.revenue).toEqual({ current: 10.01, previousAtSamePoint: 4, previousFinal: 8 });
    expect(a.campers).toEqual({ current: 3, previousAtSamePoint: 1, previousFinal: 2 });
    expect(a.guests).toEqual({ current: 0, previousAtSamePoint: 0, previousFinal: 0 });
    expect(calls[0]!.query).toContain("CAST(@cutoff AS DATE)");
    expect(calls[0]!.query).toContain("fct_revenue_pace");
    // CURRENT is a reserved word in BigQuery: it can't be a column name.
    expect(calls[0]!.query).not.toMatch(/\bAS current\b/i);
    expect(calls[0]!.types).toMatchObject({ cutoff: "STRING", cur_start: "STRING", season: "INT64", p_participants: ["STRING"] });
  });
});

describe("targets overview and report", () => {
  const thisYear = Number(new Date().toISOString().slice(0, 4));
  const seed = async () => {
    const app = api();
    await request(app)
      .put("/api/settings/targets")
      .send({
        seasons: {
          [thisYear]: { farm_store: { revenue: 900_000 }, river_school: { revenue: 300_000, guests: 3_000 } },
          [thisYear - 1]: { farm_store: { revenue: 800_000 } },
        },
      })
      .expect(200);
    return app;
  };

  it("lists every line with targets on the season its page opens on", async () => {
    const app = await seed();
    const o = (await request(app).get("/api/targets/overview").expect(200)).body;
    expect(o.lines.map((l: { businessLine: string }) => l.businessLine)).toEqual(["river_school", "farm_store"]);
    const fs = (await request(app).get("/api/targets/progress?businessLine=farm_store").expect(200)).body;
    expect(o.lines[1]).toEqual(fs);
    expect((await request(api()).get("/api/targets/overview").expect(200)).body).toEqual({ lines: [] });
  });

  it("pivots targets in the report builder, with totals and filters", async () => {
    const app = await seed();
    const run = async (spec: object) => (await request(app).post("/api/reports/run").send({ spec }).expect(200)).body;
    const byLine = await run({ dataset: "targets", rows: ["business_line"], column: "season", measure: "target", filters: { measure: ["Net revenue ($)"] } });
    const cell = (line: string, season: number) =>
      byLine.cells.find((c: { kind: string; rows: string[]; column: string }) => c.kind === "cell" && c.rows[0] === line && c.column === String(season))?.value;
    expect(cell("farm_store", thisYear)).toBe(900_000);
    expect(cell("farm_store", thisYear - 1)).toBe(800_000);
    expect(cell("river_school", thisYear)).toBe(300_000);
    expect(byLine.cells.find((c: { kind: string }) => c.kind === "total").value).toBe(2_000_000);

    const now = await run({ dataset: "targets", rows: ["business_line", "measure"], measure: "now", filters: { season: [String(thisYear)] } });
    const progress = (await request(app).get(`/api/targets/progress?businessLine=river_school&season=${thisYear}`)).body;
    const guests = now.cells.find((c: { rows: string[] }) => c.rows[0] === "river_school" && c.rows[1] === "Guests");
    expect(guests.value).toBe(progress.rows.find((r: { measure: string }) => r.measure === "guests").actual);

    const pct = await run({ dataset: "targets", rows: ["season"], measure: "of_target", filters: { business_line: ["farm_store"] } });
    const last = pct.cells.find((c: { rows: string[] }) => c.rows[0] === String(thisYear - 1));
    expect(last.value).toBeGreaterThan(0);

    const values = (await request(app).post("/api/reports/values").send({ spec: { dataset: "targets", measure: "target" }, field: "status" }).expect(200)).body;
    expect(values.values.length).toBeGreaterThan(0);
  });
});

describe("my notifications", () => {
  const on = { ...DEFAULT_NOTIFICATION_SETTINGS, slack: true, daily: "every_day" as const, alerts: { ...DEFAULT_NOTIFICATION_SETTINGS.alerts, syncStale: true } };

  it("saves each person's own choices; only admins keep admin alerts", async () => {
    const app = api();
    const first = (await request(app).get("/api/me/notifications").expect(200)).body;
    expect(first).toEqual({ settings: DEFAULT_NOTIFICATION_SETTINGS, slackConfigured: true, emailConfigured: false });
    await request(app).put("/api/me/notifications").send({ ...on, hour: 3 }).expect(400);
    expect((await request(app).put("/api/me/notifications").send(on).expect(200)).body.alerts.syncStale).toBe(true);
    expect((await request(app).get("/api/me/notifications")).body.settings).toEqual(on);

    const auth: AuthDeps = {
      allowedDomains: ["calleva.org"],
      loadAccessList: async () => ({ allowedEmails: [], admins: ["boss@calleva.org"] }),
      verifyIdToken: async () => org,
    };
    const saved = (await request(api(auth)).put("/api/me/notifications").set("Authorization", "Bearer t").send(on).expect(200)).body;
    expect(saved.alerts.syncStale).toBe(false);
  });

  it("sends a test digest to the person asking, or says Slack isn't set up", async () => {
    const messenger = new MemoryMessenger();
    const app = api(null, new NoopTrigger(), messenger);
    expect((await request(app).post("/api/me/notifications/test").expect(200)).body).toEqual({ result: "sent" });
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]!.text).toContain("Daily digest");
    expect(messenger.sent[0]!.text).toContain("<https://data.calleva.org|Open the dashboard>");
    const none = api(null, new NoopTrigger(), new NoMessenger());
    expect((await request(none).get("/api/me/notifications")).body.slackConfigured).toBe(false);
    expect((await request(none).post("/api/me/notifications/test").expect(409)).body).toEqual({ result: "not_configured" });
  });
});

describe("hourly notifications", () => {
  const thisYear = Number(new Date().toISOString().slice(0, 4));
  const setup = async (at: string) => {
    const notifications = new MemoryNotifications((email) => (email === "pat@calleva.org" ? ["farm_store", "camp"] : ["camp"]));
    const messenger = new MemoryMessenger(["pat@calleva.org", "sam@calleva.org"]);
    const alertState = new MemoryAlertState();
    let fresh: SourceFreshness[] = SOURCES.map((source) => ({ source, status: "ok", lastDataAt: at, lastSuccessAt: at, lastError: null }));
    const deps = {
      warehouse: new DemoWarehouse(),
      freshness: { freshness: async () => fresh },
      seasons: new MemorySeasonSettings(),
      targets: new MemoryTargets({ seasons: { [thisYear]: { farm_store: { revenue: 950_000 } } } }),
      notifications,
      alertState,
      messenger,
      appUrl: "https://data.calleva.org",
      now: () => new Date(at),
    };
    return { deps, notifications, messenger, alertState, setFresh: (f: SourceFreshness[]) => (fresh = f) };
  };
  const on = { ...DEFAULT_NOTIFICATION_SETTINGS, slack: true };

  it("sends digests at each person's hour, weekly on Mondays, only their lines", async () => {
    // Monday Nov 23, 2026, 7:05am Eastern.
    const { deps, notifications, messenger } = await setup("2026-11-23T12:05:00Z");
    await notifications.set("pat@calleva.org", { ...on, daily: "weekdays", weekly: true, hour: 7 });
    await notifications.set("sam@calleva.org", { ...on, daily: "weekdays", hour: 8 });
    await notifications.set("off@calleva.org", { ...on, slack: false, daily: "every_day", hour: 7 });
    const r = await runNotifications(deps);
    expect(r).toMatchObject({ hour: 7, date: "2026-11-23", subscribers: 2 });
    expect(messenger.sent.map((x) => x.email)).toEqual(["pat@calleva.org"]);
    const text = messenger.sent[0]!.text;
    expect(text).toContain("*Weekly digest · Mon, Nov 16 – Sun, Nov 22*");
    expect(text).toContain("Farm Store:");
    expect(text).not.toContain("River Store:");
    expect(text).toContain("Farm Store");
    // An hour later, Sam's daily digest (Camp only).
    messenger.sent.length = 0;
    await runNotifications({ ...deps, now: () => new Date("2026-11-23T13:05:00Z") });
    expect(messenger.sent.map((x) => x.email)).toEqual(["sam@calleva.org"]);
    expect(messenger.sent[0]!.text).toContain("*Daily digest · Sun, Nov 22*");
    expect(messenger.sent[0]!.text).not.toContain("Farm Store");
  });

  it("alerts once per change, to the people who chose that alert", async () => {
    const { deps, notifications, messenger, alertState, setFresh } = await setup("2026-11-23T15:05:00Z");
    await notifications.set("pat@calleva.org", { ...on, alerts: { ...on.alerts, syncStale: true } });
    await notifications.set("sam@calleva.org", { ...on });
    await runNotifications(deps);
    expect(messenger.sent).toEqual([]);
    expect(alertState.state.targets[`farm_store:${thisYear}:revenue`]).toBeDefined();
    setFresh(SOURCES.map((source) => ({ source, status: source === "square" ? "error" : "ok", lastDataAt: null, lastSuccessAt: "2026-11-23T15:00:00Z", lastError: null })));
    await runNotifications(deps);
    expect(messenger.sent).toEqual([{ email: "pat@calleva.org", text: expect.stringContaining("Square hasn't synced") }]);
    await runNotifications(deps);
    expect(messenger.sent).toHaveLength(1);
  });

  it("marks a target behind in its state and alerts when it moves", async () => {
    const { deps, notifications, messenger, alertState } = await setup("2026-11-23T15:05:00Z");
    await notifications.set("pat@calleva.org", { ...on, alerts: { ...on.alerts, targetBehind: true } });
    const key = `farm_store:${thisYear}:revenue`;
    await runNotifications(deps);
    const status = alertState.state.targets[key];
    // Pretend it was ahead last time: the current status is a change, so it's announced once.
    alertState.state = { ...alertState.state, targets: { [key]: status === "behind" ? "ahead" : "behind" } };
    await runNotifications(deps);
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]!.text).toMatch(/Farm Store \d{4} net revenue is (behind|back (ahead of|on) pace)/);
  });
});

describe("returning families", () => {
  type Fam = { season: number; status: string; day: number | null; wave: string; eligibleCampers: number; reenrolledCampers: number; enrolledOn: string | null };

  it("lists last season's camp-location families with whether they're back", async () => {
    const app = api();
    const { demoReturningFamilyCounts } = await import("./warehouse/demoCampminder.js");
    const r = (await request(app).get("/api/campminder/returning?season=2026").expect(200)).body;
    expect(r.season).toBe(2026);
    expect(r.seasons).toEqual([2027, 2026]);
    const fams = r.families as Fam[];
    const count = demoReturningFamilyCounts(Object.keys(DEFAULT_SEASON_SETTINGS.registration.locations)).find((c) => c.season === 2026)!.families;
    expect(fams.filter((f) => f.season === 2026)).toHaveLength(count);
    expect(r.asOf.over).toBe(new Date().toISOString().slice(0, 10) >= "2026-09-07");
    expect(r.opens["2026"]).toEqual({ va: "2026-01-06", md: "2026-01-08", new: "2026-01-12" });
    // Re-enrolled families have a day since their wave opened; the others don't.
    const back = fams.filter((f) => f.status === "enrolled");
    expect(back.length).toBeGreaterThan(0);
    expect(back.every((f) => f.day !== null && f.enrolledOn !== null)).toBe(true);
    expect(fams.filter((f) => f.status !== "enrolled").every((f) => f.day === null)).toBe(true);
    // Automatic age-out: some families aged out, none of them with a camper young enough.
    expect(typeof r.ageOutAfter["2026"]).toBe("number");
    expect(fams.filter((f) => f.status === "aged_out").every((f) => f.eligibleCampers === 0)).toBe(true);
    // 2027 hasn't any sign-ups yet: everyone's "not yet" (or aged out).
    const next = (await request(app).get("/api/campminder/returning?season=2027").expect(200)).body.families as Fam[];
    expect(next.filter((f) => f.season === 2027).every((f) => f.status === "not_yet" || f.status === "aged_out")).toBe(true);
    await request(app).get("/api/campminder/returning?season=abc").expect(400);
  });

  it("ages campers out by the setting", async () => {
    const app = api();
    const settings = (await request(app).get("/api/settings/seasons").expect(200)).body;
    expect(settings.registration.ageOutAfter).toBeNull();
    await request(app).put("/api/settings/seasons").send({ ...settings, registration: { ...settings.registration, ageOutAfter: 25 } }).expect(200);
    const r = (await request(app).get("/api/campminder/returning?season=2026").expect(200)).body;
    expect(r.ageOutSet).toBe(true);
    expect((r.families as Fam[]).some((f) => f.status === "aged_out")).toBe(false);
    await request(app).put("/api/settings/seasons").send({ ...settings, registration: { ...settings.registration, ageOutAfter: 2 } }).expect(400);
  });

  it("is a report data set with the same numbers", async () => {
    const app = api();
    const card = (await request(app).get("/api/campminder/returning?season=2026").expect(200)).body.families as Fam[];
    const cur = card.filter((f) => f.season === 2026);
    const run = async (spec: object) => (await request(app).post("/api/reports/run").send({ spec }).expect(200)).body;
    const byStatus = await run({ dataset: "returning_families", rows: ["status"], measure: "families", filters: { season: ["2026"] } });
    expect(byStatus.cells.find((c: { kind: string }) => c.kind === "total").value).toBe(cur.length);
    const pct = await run({ dataset: "returning_families", rows: ["season"], measure: "pct_reenrolled" });
    const kept = cur.filter((f) => f.status !== "aged_out");
    const row = pct.cells.find((c: { rows: string[] }) => c.rows[0] === "2026");
    expect(row.value).toBeCloseTo(kept.filter((f) => f.status === "enrolled").length / kept.length, 3);
    const campers = await run({ dataset: "returning_families", rows: [], measure: "reenrolled_campers", filters: { season: ["2026"] } });
    expect(campers.cells[0].value).toBe(kept.reduce((t, f) => t + f.reenrolledCampers, 0));
    const weeks = await run({ dataset: "returning_families", rows: ["weeks_after_opening"], measure: "reenrolled", filters: { season: ["2026"] } });
    expect(weeks.cells.some((c: { rows: string[] }) => c.rows[0] === "-1")).toBe(true);
    const values = (await request(app).post("/api/reports/values").send({ spec: { dataset: "returning_families", measure: "families" }, field: "wave" }).expect(200)).body;
    expect(values.values.map((v: { value: string }) => v.value).sort()).toEqual(["Returning MD", "Returning VA"]);
  });

  it("queries last season's camp-location households with typed parameters", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; params: Record<string, unknown>; types: Record<string, unknown> }> = [];
    const row = {
      season: 2027, household: "abc", locations: ["md"], session_group: "Farm", weeks: 4, summers: 2, state: "MD", zip: "20814",
      campers: [{ age: 9, enrolled: true }, { age: null, enrolled: false }], enrolled: true, waitlisted: false, cancelled: true, enrolled_on: "2027-01-09",
    };
    const fake = { query: async (o: (typeof calls)[number]) => (calls.push(o), [[row]]) };
    const out = await new BigQueryWarehouse(fake as never, "marts").returningFamilies({ Farm: "md" }, [2027]);
    expect(calls[0]!.params).toEqual({ locations: [{ session_group: "Farm", location: "md" }], seasons: [2027] });
    expect(calls[0]!.types).toEqual({ locations: [{ session_group: "STRING", location: "STRING" }], seasons: ["INT64"] });
    expect(calls[0]!.query).toContain("e.season + 1 AS season");
    expect(calls[0]!.query).toContain("WHERE business_line = 'camp'");
    expect(out).toEqual([
      {
        season: 2027, household: "abc", locations: ["md"], sessionGroup: "Farm", weeks: 4, summers: 2, state: "MD", zip: "20814",
        campers: [{ age: 9, enrolled: true }, { age: null, enrolled: false }], enrolled: true, waitlisted: false, cancelled: true, enrolledOn: "2027-01-09",
      },
    ]);
  });

  it("fails the self-check when a family goes missing", async () => {
    const { runSelfCheck } = await import("./selfCheck.js");
    const demo = new DemoWarehouse();
    const broken = Object.create(demo) as DemoWarehouse;
    broken.returningFamilies = async (l, s) => (await demo.returningFamilies(l, s)).slice(1);
    const result = await runSelfCheck(broken, (s, e) => demo.referenceTotals(s, e));
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["returning families match tables"]);
  }, 30_000);

  it("allows re-enrolled families without a sign-up date, but not dates that never arrive", async () => {
    const { runSelfCheck } = await import("./selfCheck.js");
    const demo = new DemoWarehouse();
    const check = async (change: (enrolledOn: string | null, i: number) => string | null) => {
      const w = Object.create(demo) as DemoWarehouse;
      w.returningFamilies = async (l, s) => (await demo.returningFamilies(l, s)).map((f, i) => ({ ...f, enrolledOn: change(f.enrolledOn, i) }));
      return (await runSelfCheck(w, (s, e) => demo.referenceTotals(s, e))).checks.find((c) => c.name === "returning families match tables");
    };
    // Campminder has a few enrollments with no application date.
    expect((await check((d, i) => (i % 50 === 0 ? null : d)))!.ok).toBe(true);
    expect(await check(() => null)).toMatchObject({ ok: false, detail: "no re-enrolled family has a sign-up date" });
    expect(await check((d) => (d ? "01/09/2027" : d))).toMatchObject({ ok: false, detail: "a re-enrolled family's sign-up date isn't a date" });
  }, 60_000);

  it("puts re-enrollment in the digest while registration is under way", async () => {
    const { buildDigest } = await import("./notify.js");
    const { digestSlackText } = await import("@dash/shared");
    const deps = { warehouse: new DemoWarehouse(), freshness: new DemoFreshness(), seasons: new MemorySeasonSettings(), targets: new MemoryTargets(), appUrl: "https://x" };
    const during = await buildDigest(deps, "daily", "2026-02-02");
    expect(during.returning?.season).toBe(2026);
    expect(digestSlackText(during, ["camp"])).toMatch(/Camp returning families 2026: [\d,]+ of [\d,]+ re-enrolled \(\d+%\)/);
    expect(digestSlackText(during, ["farm_store"])).not.toContain("returning families");
    // Before 2027's opening dates are set and before anyone has re-enrolled: nothing.
    expect((await buildDigest(deps, "daily", "2026-11-23")).returning).toBeNull();
  });
});

describe("revenue per camper", () => {
  it("gives every charge and discount to campers, and adds back up to net tuition", async () => {
    const app = api();
    const per = (await request(app).get("/api/campminder/per-camper?season=2026&businessLine=camp").expect(200)).body;
    const fin = (await request(app).get("/api/campminder/finance?season=2026&businessLine=camp").expect(200)).body;
    const summary = (await request(app).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200)).body;
    expect(per.current.campers).toBe(summary.current.campers);
    expect(per.current.tuition).toBeGreaterThan(0);
    expect(per.current.weeks).toBeGreaterThanOrEqual(per.current.campers);
    // Default extras (lunches, gear, cancellation fees) are kept apart from tuition.
    expect(per.current.extras).toBeGreaterThan(0);
    expect(per.current.tuition + per.current.extras + per.current.notPerCamper).toBeCloseTo(fin.netTuition, 0);
    // Cancelled campers' charges aren't counted per camper.
    expect(per.current.notPerCamper).toBeGreaterThan(0);
    expect(per.previous).not.toBeNull();
    // With the page's filters: the matching camper-sessions and what was given to them.
    const f = encodeURIComponent(JSON.stringify({ session_group: ["Farm"] }));
    const farm = (await request(app).get(`/api/campminder/per-camper?season=2026&businessLine=camp&filters=${f}`).expect(200)).body;
    const farmSummary = (await request(app).get(`/api/campminder/summary?season=2026&businessLine=camp&filters=${f}`).expect(200)).body;
    expect(farm.filtered).toBe(true);
    expect(farm.current.campers).toBe(farmSummary.current.campers);
    expect(farm.current.tuition).toBeLessThan(per.current.tuition);
    expect(farm.current.notPerCamper).toBe(0);
    await request(app).get("/api/campminder/per-camper?season=x").expect(400);
  });

  it("splits a discount under a parent across the household's campers by their charges", async () => {
    const { demoTuitionAlloc, demoTransactions } = await import("./warehouse/demoCampminder.js");
    const lines = demoTransactions().filter((t) => t.type === "debit" || t.type === "credit");
    const alloc = demoTuitionAlloc([]);
    // Nothing is lost or made up: every season's lines add up to what was given out.
    for (const season of [2025, 2026]) {
      const total = lines.filter((t) => t.season === season).reduce((a, t) => a + t.amount, 0);
      expect(alloc.filter((a) => a.season === season).reduce((a, x) => a + x.tuition + x.extras, 0)).toBeCloseTo(total, 2);
    }
    // Parents' discounts reach campers.
    expect(lines.some((t) => t.person === null)).toBe(true);
    const parentDiscounts = lines.filter((t) => t.person === null).reduce((a, t) => a + t.amount, 0);
    const unassigned = alloc.filter((a) => a.camper === null).reduce((a, x) => a + x.tuition + x.extras, 0);
    expect(Math.abs(unassigned)).toBeLessThan(Math.abs(parentDiscounts));
  });

  it("queries per-camper tuition with typed parameters and the proportional split", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; params: Record<string, unknown>; types: Record<string, unknown> }> = [];
    const row = { season: 2026, campers: 10, weeks: 30, tuition: 19500.004, extras: 450, not_per_camper: 650, lines: 40 };
    const fake = { query: async (o: (typeof calls)[number]) => (calls.push(o), [[row]]) };
    const out = await new BigQueryWarehouse(fake as never, "marts").camperTuition({ season: 2026, businessLine: "camp", filters: {} }, { prevCutoff: "2025-11-24", extras: ["Lunch"] });
    const c = calls[0]!;
    expect(c.params).toMatchObject({ season: 2026, prev_cutoff: "2025-11-24", extras: ["Lunch"], category: "Summer Camp", business_line: "camp" });
    expect(c.types).toMatchObject({ season: "INT64", prev_cutoff: "STRING", extras: ["STRING"], category: "STRING" });
    expect(c.query).toContain("w / SUM(w) OVER (PARTITION BY line_id)");
    expect(c.query).toContain("post_date <= CAST(@prev_cutoff AS DATE)");
    expect(c.query).not.toContain("JOIN (SELECT DISTINCT season, camper_hash, session_name FROM kept)");
    expect(out.current).toEqual({ campers: 10, weeks: 30, tuition: 19500, extras: 450, notPerCamper: 650, lines: 40 });
    expect(out.previous).toBeNull(); // no 2025 row: no financials
    expect(out.previousCutoff).toBe("2025-11-24");
    await new BigQueryWarehouse(fake as never, "marts").camperTuition({ season: 2026, filters: { week: ["1"] } }, { prevCutoff: "9999-12-31", extras: [] });
    expect(calls[1]!.query).toContain("JOIN (SELECT DISTINCT season, camper_hash, session_name FROM kept)");
  });

  it("reports net tuition per camper, each camper once however records are split", async () => {
    const app = api();
    const run = async (spec: object) => (await request(app).post("/api/reports/run").send({ spec }).expect(200)).body;
    const per = (await request(app).get("/api/campminder/per-camper?season=2026&businessLine=camp").expect(200)).body;
    const base = { dataset: "camper_seasons", filters: { season: ["2026"], business_line: ["camp"] } };
    const total = await run({ ...base, rows: [], measure: "net_tuition" });
    expect(total.cells[0].value).toBeCloseTo(per.current.tuition, 0);
    const avg = await run({ ...base, rows: [], measure: "tuition_per_camper" });
    expect(avg.cells[0].value).toBeCloseTo(per.current.tuition / per.current.campers, 0);
    // Split by session group (a camper in two groups is a record in each): the total still counts each camper once.
    const byGroup = await run({ ...base, rows: ["session_group"], measure: "net_tuition" });
    expect(byGroup.cells.find((c: { kind: string }) => c.kind === "total").value).toBeCloseTo(per.current.tuition, 0);
    const cells = byGroup.cells.filter((c: { kind: string }) => c.kind === "cell");
    expect(cells.reduce((t: number, c: { value: number }) => t + c.value, 0)).toBeGreaterThan(per.current.tuition);
    const extras = await run({ ...base, rows: [], measure: "extras_per_camper" });
    expect(extras.cells[0].value).toBeCloseTo(per.current.extras / per.current.campers, 0);
  });

  it("only joins the financials when a tuition measure is asked for", async () => {
    const { compileReport } = await import("./warehouse/reportSql.js");
    const spec = (measure: string) => reportSpecSchema.parse({ dataset: "camper_seasons", rows: ["session_group"], measure });
    const plain = compileReport(spec("campers"), "marts", { overrides: {} });
    expect(plain.sql).not.toContain("tuition_alloc");
    expect(plain.params.extras).toBeUndefined();
    const money = compileReport(spec("tuition_per_camper"), "marts", { overrides: {} }, new Map(), ["Lunch"]);
    expect(money.sql).toContain("tuition_alloc");
    // Each camper once, with plain SUM(DISTINCT): BigQuery refuses aggregates inside UNNEST.
    expect(money.sql).toContain("SUM(DISTINCT IF(tuition IS NULL, NULL, CAST(FARM_FINGERPRINT(");
    expect(money.sql).not.toMatch(/UNNEST\(ARRAY_AGG/);
    expect(money.params).toMatchObject({ extras: ["Lunch"], category: "Summer Camp" });
  });
});

describe("where new families come from", () => {
  const q = (f: object) => encodeURIComponent(JSON.stringify(f));

  it("tells new families from returning ones, and filters the whole page to them", async () => {
    const app = api();
    const all = (await request(app).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200)).body.current;
    expect(all.newFamilies).toBeGreaterThan(0);
    expect(all.newFamilies).toBeLessThan(all.families);
    const onlyNew = (await request(app).get(`/api/campminder/summary?season=2026&businessLine=camp&filters=${q({ new_family: ["New family"] })}`).expect(200)).body.current;
    const onlyBack = (await request(app).get(`/api/campminder/summary?season=2026&businessLine=camp&filters=${q({ new_family: ["Returning family"] })}`).expect(200)).body.current;
    expect(onlyNew.families).toBe(all.newFamilies);
    expect(onlyNew.newFamilies).toBe(onlyNew.families);
    expect(onlyNew.families + onlyBack.families).toBe(all.families);
    // The map follows the filter.
    const map = (await request(app).get(`/api/campminder/map?season=2026&businessLine=camp&filters=${q({ new_family: ["New family"] })}`).expect(200)).body;
    expect(map.points.length).toBeGreaterThan(0);
  });

  it("breaks new families down by how they heard and what they came through", async () => {
    const app = api();
    const f = q({ new_family: ["New family"] });
    const heard = (await request(app).get(`/api/campminder/breakdown?season=2026&businessLine=camp&dimension=heard&filters=${f}`).expect(200)).body.rows;
    const keys = heard.map((r: { key: string }) => r.key);
    expect(keys).toContain("Current Camper Family");
    expect(keys).toContain("(unknown)"); // didn't answer
    expect(keys.every((k: string) => ["Facebook", "Instagram", "Current Camper Family", "Current Staff Member", "Web Search", "Other", "(unknown)"].includes(k))).toBe(true);
    const through = (await request(app).get(`/api/campminder/breakdown?season=2026&businessLine=camp&dimension=came_through&filters=${f}`).expect(200)).body.rows;
    expect(through.map((r: { key: string }) => r.key)).toContain("Directly");
    expect(through.every((r: { key: string }) => r.key === "Directly" || r.key.endsWith(" first"))).toBe(true);
    // Returning families came through nothing.
    const back = (await request(app).get(`/api/campminder/breakdown?season=2026&businessLine=camp&dimension=came_through&filters=${q({ new_family: ["Returning family"] })}`).expect(200)).body.rows;
    expect(back.map((r: { key: string }) => r.key)).toEqual(["(unknown)"]);
  });

  it("reports new families by how they heard, with new and returning adding up", async () => {
    const app = api();
    const run = async (spec: object) => (await request(app).post("/api/reports/run").send({ spec }).expect(200)).body;
    const fams = await run({ dataset: "families", rows: ["new_family"], measure: "families", filters: { business_line: ["camp"], season: ["2026"] } });
    const cell = (k: string) => fams.cells.find((c: { kind: string; rows: string[] }) => c.kind === "cell" && c.rows[0] === k)?.value;
    const total = fams.cells.find((c: { kind: string }) => c.kind === "total").value;
    expect(cell("New family") + cell("Returning family")).toBe(total);
    const summary = (await request(app).get("/api/campminder/summary?season=2026&businessLine=camp").expect(200)).body.current;
    expect(cell("New family")).toBe(summary.newFamilies);
    const starter = await run({ dataset: "families", rows: ["heard_about"], column: "season", measure: "families", filters: { business_line: ["camp"], new_family: ["New family"] } });
    expect(starter.cells.some((c: { rows: string[] }) => c.rows[0] === "Web Search")).toBe(true);
    await run({ dataset: "camper_seasons", rows: ["came_through", "heard_about"], measure: "campers", filters: { new_family: ["New family"] } });
  });

  it("labels families in SQL from fixed fragments only", async () => {
    const { familyStatusSql } = await import("./warehouse/familyStatusSql.js");
    const sql = familyStatusSql("`marts.fct_campminder_enrollments`");
    expect(sql).toContain("WHEN 'chaps' THEN 'CHAPs'");
    expect(sql).toContain("'New family'");
    expect(sql).toContain("o.season < a.season OR (o.season = a.season AND o.first_app < a.first_app)");
  });
});
