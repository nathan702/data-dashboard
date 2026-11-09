import { describe, expect, it } from "vitest";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "../core/memory.js";
import { runSync } from "../core/runner.js";
import { EnvSecretStore } from "../core/secrets.js";
import { WebhookAuthError } from "../core/types.js";
import { easternDate, FareharborConnector, fhTime, sanitizeBooking, type StoredHashes } from "./fareharbor.js";

const listBooking = (uuid: string, created: string, extra: Record<string, unknown> = {}) => ({
  uuid,
  status: "active",
  paid_status: "paid",
  created_at: created,
  updated_at: created,
  activity_date: "2026-10-31T00:30:00Z",
  currency: "usd",
  gross_total: 7000,
  refund_total: 0,
  net_total: 7000,
  amount_paid: 7000,
  customer_count: 2,
  customer_breakdown: "2 Adult",
  display_id: "#A1B2C3",
  external_id: "ext-9",
  item: { pk: 1867, name: "Haunted Trail", headline: "Spooky" },
  customer_profile: { uuid: "cp-1", name: "Surfer Dude", email: "surfer@dude.com", phone: "+14432221100" },
  tags: [{ pk: 1, name: "Smith party" }],
  custom_field_values: [{ name: "Child's name", display_value: "Sam" }],
  voucher_number: "V-1",
  ...extra,
});

describe("fareharbor parsing", () => {
  it("keeps only allow-listed booking fields", () => {
    const b = sanitizeBooking(listBooking("b-1", "2026-09-01T14:00:00Z"), "hauntedforest")!;
    const text = JSON.stringify(b);
    for (const secret of ["Surfer", "dude.com", "443", "Sam", "V-1", "#A1B2C3", "ext-9", "Smith", "cp-1", "Spooky"]) expect(text).not.toContain(secret);
    expect(b).toMatchObject({
      uuid: "b-1",
      company: "hauntedforest",
      status: "active",
      itemName: "Haunted Trail",
      // 8:30pm Eastern on Oct 30 is 00:30 UTC on Oct 31.
      activityDate: "2026-10-30",
      createdDate: "2026-09-01",
      grossTotal: 7000,
      customerBreakdown: "2 Adult",
    });
  });

  it("hashes what's stored, ignoring updatedAt", () => {
    const a = sanitizeBooking(listBooking("b", "2026-09-01T14:00:00Z"), "x")!;
    expect(sanitizeBooking(listBooking("b", "2026-09-01T14:00:00Z", { updated_at: "2026-09-05T00:00:00Z", customer_profile: { name: "Other" } }), "x")!.rowHash).toBe(a.rowHash);
    expect(sanitizeBooking(listBooking("b", "2026-09-01T14:00:00Z", { status: "cancelled" }), "x")!.rowHash).not.toBe(a.rowHash);
  });

  it("reads datetimes", () => {
    expect(fhTime("2015-01-22T11:30:00-1000")).toBe("2015-01-22T21:30:00.000Z");
    expect(fhTime("nope")).toBeNull();
    expect(easternDate("2026-07-04T03:00:00Z")).toBe("2026-07-03");
  });
});

interface Setup {
  stored?: Map<string, string>;
  env?: Record<string, string>;
  bookings?: unknown[];
  itemsForbidden?: boolean;
}

function setup(opts: Setup = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const bookings = opts.bookings ?? [listBooking("b-1", "2026-09-01T14:00:00Z"), listBooking("b-2", "2026-09-02T14:00:00Z")];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "wrong.test") return new Response("Forbidden", { status: 403 });
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/token/")) {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (url.host === "first.test") return new Response("<html>403</html>", { status: 403 });
      return body.client_secret === "secret" ? new Response(JSON.stringify({ token: `tok-${body.organization}` })) : new Response('{"error":"invalid"}', { status: 401 });
    }
    if ((init?.headers as Record<string, string>).Authorization !== "Bearer tok-hauntedforest") return new Response("{}", { status: 401 });
    expect(url.searchParams.get("company_shortname")).toBe("hauntedforest");
    const offset = Number(url.searchParams.get("offset"));
    const page = (rows: unknown[]) => new Response(JSON.stringify({ data: rows.slice(offset, offset + 100), meta: { total_count: rows.length, limit: 100, offset } }));
    if (url.pathname === "/v1/items/" && opts.itemsForbidden) return new Response('{"title":"Forbidden"}', { status: 403 });
    if (url.pathname === "/v1/items/") return page([{ pk: 1867, name: "Haunted Trail", description: "long", images: ["x"] }]);
    if (url.pathname === "/v1/bookings/") return page(bookings);
    if (url.pathname === "/v1/availabilities/") return page(url.searchParams.get("start_after")!.startsWith("2026-08") ? [{ id: 55, item: { pk: 1867 }, start_at_utc: "2026-10-31T00:00:00Z", capacity: 120, status: "auto" }] : []);
    if (url.pathname === "/v1/bookings/b-1") return new Response(JSON.stringify({ data: listBooking("b-1", "2026-09-01T14:00:00Z", { status: "cancelled" }) }));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const stored: StoredHashes = { load: async () => new Map(opts.stored ?? []) };
  const c = new FareharborConnector({
    secrets: new EnvSecretStore({
      FAREHARBOR_COMPANIES: "hauntedforest",
      FAREHARBOR_HAUNTEDFOREST_CLIENT_ID: "id",
      FAREHARBOR_HAUNTEDFOREST_CLIENT_SECRET: "secret",
      ...opts.env,
    }),
    baseUrls: ["https://wrong.test/api", "https://fh.test/v1"],
    tokenUrls: ["https://first.test/token/", "https://fh.test/auth/token/"],
    historyStart: "2019-01-01",
    stored,
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-09-10T12:00:00Z"),
  });
  const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
  return { c, calls, bodies, deps };
}

const ids = (deps: { writer: MemoryRawWriter }, e: string) => deps.writer.rows.filter((r) => r.record.entity === e).map((r) => r.record.recordId);

describe("fareharbor sync", () => {
  it("signs in per company and reads items, bookings and time slots", async () => {
    const { c, calls, bodies, deps } = setup();
    const result = await runSync(c, deps, "incremental");
    expect(result.status).toBe("ok");
    // The first token host failed with a non-credential error, so the second was tried.
    expect(bodies[0]).toEqual({ client_id: "id", client_secret: "secret", organization: "hauntedforest" });
    expect(ids(deps, "companies")).toEqual(["hauntedforest"]);
    expect(ids(deps, "items")).toEqual(["hauntedforest:1867"]);
    expect(ids(deps, "bookings")).toEqual(["b-1", "b-2"]);
    expect(ids(deps, "availabilities")).toEqual(["hauntedforest:55"]);
    expect(calls.some((p) => p.startsWith("/v1/bookings/?") && p.includes("created_after=2018-12-31T23%3A50%3A00.000Z") && p.includes("sort_by=created_at"))).toBe(true);
    expect(calls.some((p) => p.includes("sort_by=activity_date"))).toBe(true);
    expect(JSON.stringify(deps.writer.rows)).not.toContain("Surfer");
    const cursors = (await deps.state.get("fareharbor")).cursors;
    expect(cursors["created:hauntedforest"]).toBe("2026-09-02T14:00:00.000Z");
    expect(cursors["full:hauntedforest"]).toBe("2026-09-10T12:00:00.000Z");
    expect(cursors["recent:hauntedforest"]).toBe("2026-09-10T12:00:00.000Z");
  });

  it("pages through more than 100 bookings and skips unchanged ones", async () => {
    const many = Array.from({ length: 250 }, (_, i) => listBooking(`b-${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()));
    const first = setup({ bookings: many });
    await runSync(first.c, first.deps, "incremental");
    expect(new Set(ids(first.deps, "bookings")).size).toBe(250);

    const stored = new Map<string, string>();
    for (const r of first.deps.writer.rows) {
      const p = r.record.payload as { rowHash?: string };
      if (p.rowHash) stored.set(r.record.entity === "availabilities" ? `a:${r.record.recordId}` : r.record.recordId, p.rowHash);
    }
    const second = setup({ bookings: many, stored });
    await runSync(second.c, second.deps, "backfill");
    expect(ids(second.deps, "bookings")).toEqual([]);
  });

  it("carries on with bookings when the item list is refused", async () => {
    const { c, deps } = setup({ itemsForbidden: true });
    const result = await runSync(c, deps, "incremental");
    expect(result.status).toBe("ok");
    expect(ids(deps, "items")).toEqual([]);
    expect(ids(deps, "bookings")).toEqual(["b-1", "b-2"]);
  });

  it("reports not connected until a company's keys are stored", async () => {
    const { c, deps } = setup({ env: { FAREHARBOR_COMPANIES: "hauntedforest,riverschool" } });
    const result = await runSync(c, deps, "incremental");
    expect(result).toMatchObject({ status: "ok", notConfigured: true });
  });

  it("fails clearly on wrong credentials without echoing them", async () => {
    const { c, deps } = setup({ env: { FAREHARBOR_HAUNTEDFOREST_CLIENT_SECRET: "wrong" } });
    const result = await runSync(c, deps, "incremental");
    expect(result.status).toBe("error");
    expect(result.error).toContain("sign-in failed for hauntedforest (HTTP 401)");
    expect(result.error).not.toContain("wrong");
  });
});

describe("fareharbor webhooks", () => {
  const req = (key: string, body: unknown) => ({ headers: {}, rawBody: Buffer.from(JSON.stringify(body)), url: `https://hooks.test/webhooks/fareharbor?key=${key}` });
  const hook = { booking: { uuid: "b-1", company: { shortname: "hauntedforest" }, contact: { name: "Surfer Dude" }, status: "booked" } };

  it("rejects a wrong key and re-reads the booking for a right one", async () => {
    const { c } = setup({ env: { FAREHARBOR_WEBHOOK_KEY: "s3cret-key" } });
    await expect(c.handleWebhook(req("wrong", hook))).rejects.toBeInstanceOf(WebhookAuthError);
    const records = await c.handleWebhook(req("s3cret-key", hook));
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({ uuid: "b-1", status: "cancelled" });
    expect(JSON.stringify(records)).not.toContain("Surfer");
  });

  it("ignores companies it wasn't set up for, and refuses until a key is stored", async () => {
    const { c } = setup({ env: { FAREHARBOR_WEBHOOK_KEY: "k" } });
    expect(await c.handleWebhook(req("k", { booking: { ...hook.booking, company: { shortname: "someoneelse" } } }))).toEqual([]);
    await expect(setup().c.handleWebhook(req("", hook))).rejects.toBeInstanceOf(WebhookAuthError);
  });
});
