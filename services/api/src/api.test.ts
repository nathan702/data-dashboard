import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApi } from "./app.js";
import { decideAccess, type AuthDeps } from "./auth.js";
import { loadConfig } from "./config.js";
import { MemoryPreferences } from "./preferences.js";
import { NoopTrigger } from "./refresh.js";
import { MemorySeasonSettings } from "./seasons.js";
import { MemoryProgramFamilies, MemoryReports, MemorySchools } from "./reports.js";
import { CALENDAR_YEAR, campminderCalendar, DEFAULT_SEASON_SETTINGS } from "@dash/shared";
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

function api(auth: AuthDeps | null = null, refresh = new NoopTrigger()) {
  return createApi({
    auth,
    warehouse: new DemoWarehouse(),
    freshness: new DemoFreshness(),
    preferences: new MemoryPreferences(),
    seasons: new MemorySeasonSettings(),
    reports: new MemoryReports(),
    programFamilies: new MemoryProgramFamilies(),
    schools: new MemorySchools(),
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

  it("buckets seasons from the line's season starts, passed as DATEs", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; params: Record<string, unknown>; types: Record<string, unknown> }> = [];
    const fake = { query: async (o: never) => (calls.push(o), [[]]) };
    await new BigQueryWarehouse(fake as never, "marts").revenueSummary({
      start: "2026-01-01", end: "2026-10-31", basis: "service", measure: "net", granularity: "season",
      compare: "previous_year", groupBy: "business_line", businessLines: ["school_year"],
    }, campminderCalendar());
    const series = calls.find((c) => c.query.includes("UNNEST(@season_starts)"))!;
    expect(series.params.season_starts).toEqual(["2024-09-02", "2025-09-01", "2026-09-07"]);
    expect(series.types.season_starts).toEqual(["DATE"]);
  });

  it("starts Campminder pace on each season's first day, passed as DATEs", async () => {
    const { BigQueryWarehouse } = await import("./warehouse/bigquery.js");
    const calls: Array<{ query: string; params: Record<string, unknown>; types: Record<string, unknown> }> = [];
    const fake = { query: async (o: never) => (calls.push(o), [[]]) };
    await new BigQueryWarehouse(fake as never, "marts").enrollmentSummary({ season: 2026, filters: {} }, campminderCalendar());
    const pace = calls.find((c) => c.query.includes("week_of_season"))!;
    expect(pace.params).toMatchObject({ cur_start: "2025-09-01", prev_start: "2024-09-02" });
    expect(pace.types).toMatchObject({ cur_start: "DATE", prev_start: "DATE" });
    expect(calls.find((c) => c.query.includes("@prev_cutoff"))!.types).toMatchObject({ prev_cutoff: "DATE" });
  });
});

describe("deploy self-check", () => {
  it("passes when the API's queries agree with the tables", async () => {
    const res = await request(api()).get("/healthz/deep").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.length).toBeGreaterThanOrEqual(5);
  });

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
    ]);
  });

  it("catches enrollment totals that disagree with the table", async () => {
    const { runSelfCheck } = await import("./selfCheck.js");
    const demo = new DemoWarehouse();
    const broken = Object.create(demo) as DemoWarehouse;
    broken.enrollmentBreakdown = async (q) => ({ ...(await demo.enrollmentBreakdown(q)), rows: [] });
    const result = await runSelfCheck(broken, (s, e) => demo.referenceTotals(s, e));
    // The School breakdown is checked against the same table count.
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["campminder enrollments match tables", "school grouping runs"]);
  });
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
    await request(app).put("/api/settings/schools").send({ overrides: { RDS: "Riverbend Day School" } }).expect(200);
    const after = await request(app).get("/api/campminder/breakdown?season=2026&businessLine=camp&dimension=school").expect(200);
    expect(after.body.rows.map((r: { key: string }) => r.key)).not.toContain("RDS");
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
      { dataset: "store_sales", rows: ["item"], column: "month", measure: "net", filters: { category: [evil] }, start: "2026-01-01", end: "2026-01-31", chart: "table", percent: "none" },
      "marts",
      { overrides: {} },
    );
    expect(sql).not.toContain("DROP");
    expect(params.f0).toEqual([evil]);
    expect(sql).toContain("GROUPING SETS ((r0, c), (r0), (c), ())");
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

  it("groups school spellings, and Settings → Schools overrides them", async () => {
    const app = api();
    const before = await request(app).get("/api/settings/schools").expect(200);
    const row = (entered: string) => before.body.spellings.find((s: { entered: string }) => s.entered === entered);
    expect(row("Hilltop")).toMatchObject({ school: "The Hilltop School", origin: "grouped" });
    expect(row("N/A")).toMatchObject({ school: null });
    const schools = async () =>
      (await run(app, { dataset: "camper_seasons", rows: ["school"], measure: "campers" }).expect(200)).body.cells.map((c: { rows: string[] }) => c.rows[0]);
    expect(await schools()).not.toContain("Hilltop");
    expect(await schools()).toContain("RDS"); // an abbreviation needs Settings
    await request(app).put("/api/settings/schools").send({ overrides: { RDS: "Riverbend Day School" } }).expect(200);
    expect(await schools()).toContain("Riverbend Day School");
    expect(await schools()).not.toContain("RDS");
  });
});
