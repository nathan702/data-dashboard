import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApi } from "./app.js";
import { decideAccess, type AuthDeps } from "./auth.js";
import { loadConfig } from "./config.js";
import { MemoryPreferences } from "./preferences.js";
import { NoopTrigger } from "./refresh.js";
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
    expect(periodBucket("2026-09-23", "2025-09-01", "week")).toBe("2026-09-21");
    expect(periodBucket("2026-09-21", "2025-09-01", "week")).toBe("2026-09-21");
    expect(periodBucket("2026-09-20", "2025-09-01", "week")).toBe("2026-09-14");
    const base = { businessLine: "farm_store" as const, source: "square" as const };
    const rows = [
      { ...base, date: "2026-01-01", seasonStart: "2025-09-01", gross: 100, discounts: 10, refunds: 5, fees: 3, transactions: 2 },
      { ...base, date: "2025-01-01", seasonStart: "2024-09-01", gross: 50, discounts: 0, refunds: 0, fees: 1, transactions: 1 },
    ];
    const s = summarizeRows(rows, {
      start: "2026-01-01", end: "2026-01-01", basis: "booked", measure: "net_after_fees", granularity: "day",
      compare: "previous_year", groupBy: "business_line", businessLines: ["farm_store"],
    });
    expect(s.groups[0]!.current).toMatchObject({ gross: 100, net: 85, netAfterFees: 82, transactions: 2 });
    expect(s.groups[0]!.comparison).toMatchObject({ gross: 50, netAfterFees: 49 });
    expect(s.series).toEqual([{ period: "2026-01-01", key: "farm_store", value: 82 }]);
  });

  it("demo data is deterministic", () => {
    expect(demoRow(DEMO_STREAMS[0]!, "2026-01-05", "booked")).toEqual(demoRow(DEMO_STREAMS[0]!, "2026-01-05", "booked"));
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
  });
});

describe("comparison series", () => {
  it("puts last year's values on this year's buckets", () => {
    const row = (date: string, gross: number) => ({ businessLine: "farm_store" as const, source: "square" as const, date, seasonStart: "2025-09-01", gross, discounts: 0, refunds: 0, fees: 0, transactions: 1 });
    const s = summarizeRows([row("2026-06-02", 100), row("2025-06-02", 60), row("2025-06-03", 40)], {
      start: "2026-06-01", end: "2026-06-07", basis: "booked", measure: "gross", granularity: "week",
      compare: "previous_year", groupBy: "business_line", businessLines: ["farm_store"],
    });
    expect(s.series).toEqual([{ period: "2026-06-01", key: "farm_store", value: 100 }]);
    expect(s.comparisonSeries).toEqual([{ period: "2026-06-01", key: "farm_store", value: 100 }]);
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
    });
    for (const q of queries) {
      expect(q).toContain("COALESCE(ARRAY_LENGTH(@sources), 0) = 0");
      expect(q).toContain("COALESCE(ARRAY_LENGTH(@business_lines), 0) = 0");
    }
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
});
