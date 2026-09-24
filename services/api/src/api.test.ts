import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApi } from "./app.js";
import { decideAccess, type AuthDeps } from "./auth.js";
import { loadConfig } from "./config.js";
import { DemoFreshness, DemoWarehouse, demoRow } from "./warehouse/demo.js";
import { periodBucket, summarizeRows } from "./warehouse/summarize.js";

// Shaped like a real Firebase ID token from Google sign-in (no "hd" claim).
const org = { email: "pat@calleva.org", email_verified: true, name: "Pat", firebase: { sign_in_provider: "google.com" } };

describe("access decisions", () => {
  const open = { allowedEmails: [], admins: ["pat@calleva.org"] };
  it("allows verified accounts in the organization domain", () => {
    expect(decideAccess(org, open, ["calleva.org"])).toEqual({
      ok: true,
      viewer: { email: "pat@calleva.org", name: "Pat", isAdmin: true },
    });
  });
  it("rejects personal accounts, unverified emails and non-Google sign-in", () => {
    expect(decideAccess({ ...org, email: "pat@gmail.com" }, open, ["calleva.org"]).ok).toBe(false);
    expect(decideAccess({ ...org, email_verified: false }, open, ["calleva.org"]).ok).toBe(false);
    expect(decideAccess({ ...org, firebase: { sign_in_provider: "password" } }, open, ["calleva.org"]).ok).toBe(false);
    expect(decideAccess({ ...org, firebase: undefined }, open, ["calleva.org"]).ok).toBe(false);
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

function api(auth: AuthDeps | null = null) {
  return createApi({ auth, warehouse: new DemoWarehouse(), freshness: new DemoFreshness(), corsOrigins: ["https://dash.web.app"], cacheTtlSeconds: 60 });
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
      .get("/api/revenue/summary?start=2026-06-01&end=2026-06-30&businessLines=shopify,square&granularity=week")
      .expect(200);
    expect(res.body.byLine.map((b: { businessLine: string }) => b.businessLine)).toEqual(["shopify", "square"]);
    expect(res.body.comparisonRange).toEqual({ start: "2025-06-01", end: "2025-06-30" });
    expect(res.body.byLine[0].current.gross).toBeGreaterThan(0);
    expect(res.body.series.every((p: { period: string }) => p.period >= "2026-05-25")).toBe(true);
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
    const rows = [
      { businessLine: "square" as const, date: "2026-01-01", seasonStart: "2025-09-01", gross: 100, discounts: 10, refunds: 5, fees: 3, transactions: 2 },
      { businessLine: "square" as const, date: "2025-01-01", seasonStart: "2024-09-01", gross: 50, discounts: 0, refunds: 0, fees: 1, transactions: 1 },
    ];
    const s = summarizeRows(
      rows,
      { start: "2026-01-01", end: "2026-01-01", basis: "booked", measure: "net_after_fees", granularity: "day", compare: "previous_year" },
      ["square"],
    );
    expect(s.byLine[0]!.current).toMatchObject({ gross: 100, net: 85, netAfterFees: 82, transactions: 2 });
    expect(s.byLine[0]!.comparison).toMatchObject({ gross: 50, netAfterFees: 49 });
    expect(s.series).toEqual([{ period: "2026-01-01", businessLine: "square", value: 82 }]);
  });

  it("demo data is deterministic", () => {
    expect(demoRow("shopify", "2026-01-05", "booked")).toEqual(demoRow("shopify", "2026-01-05", "booked"));
  });
});

describe("retail endpoints", () => {
  it("returns KPIs with comparison and derived net/AOV", async () => {
    const res = await request(api()).get("/api/retail/square/kpis?start=2026-07-01&end=2026-07-31").expect(200);
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

  it("rejects unknown lines and dimensions", async () => {
    await request(api()).get("/api/retail/hubspot/kpis?start=2026-07-01&end=2026-07-31").expect(404);
    await request(api()).get("/api/retail/shopify/breakdown?start=2026-07-01&end=2026-07-31&dimension=customer").expect(400);
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
      expect(sql).toContain("@line");
      expect(sql).toContain("LIMIT @limit_plus_one");
    }
    expect(kpiSql("marts")).toContain("fct_retail_orders");
  });
});
