import { describe, expect, it } from "vitest";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "../core/memory.js";
import { runSync } from "../core/runner.js";
import { EnvSecretStore } from "../core/secrets.js";
import { WebhookAuthError } from "../core/types.js";
import { FareharborConnector, fhLocalDate, fhTime, monthChunks, sanitizeBooking, type StoredHashes } from "./fareharbor.js";

const fullBooking = {
  pk: 6876876,
  uuid: "b-1",
  status: "booked",
  display_id: "#12",
  company: { shortname: "riverschool", name: "River School", currency: "usd" },
  availability: { pk: 4786, start_at: "2026-07-22T11:30:00-0400", end_at: "2026-07-22T13:30:00-0400", item: { pk: 1867, name: "Paddle Tour" } },
  contact: { name: "Surfer Dude", phone: "+1-443-222-1100", normalized_phone: "+14432221100", email: "surfer@dude.com" },
  note: "allergic to peanuts — call Jane",
  voucher_number: "V-1",
  confirmation_url: "https://fareharbor.com/x",
  dashboard_url: "https://fareharbor.com/y",
  custom_field_values: [{ name: "Child's name", value: "Sam" }],
  customers: [
    {
      checkin_url: "https://fhchk.co/abc",
      checkin_status: { name: "checked in", type: "checked-in" },
      total_cost: { price: 20000, tax: 1200, total: 21200 },
      customer_type_rate: { pk: 65675, customer_type: { pk: 978, singular: "Adult", plural: "Adults" } },
      custom_field_values: [{ name: "Name", value: "Sam" }],
    },
  ],
  customer_count: 1,
  receipt_subtotal: 20000,
  receipt_taxes: 1200,
  receipt_total: 21200,
  amount_paid: 21200,
  desk: { pk: 1, name: "Front desk" },
  payments: [
    {
      pk: 236495,
      created_at: "2026-03-23T11:36:36-0700",
      type: "card",
      status: "succeeded",
      amount_paid: 21200,
      refunds: [{ pk: 9, created_at: "2026-03-24T10:00:00-0400", amount_refunded: 5000, is_cancelled: false }],
    },
  ],
};

describe("fareharbor parsing", () => {
  it("keeps only allow-listed booking fields", () => {
    const b = sanitizeBooking(fullBooking, "riverschool")!;
    const text = JSON.stringify(b);
    for (const secret of ["Surfer", "dude.com", "443", "peanuts", "Jane", "Sam", "V-1", "fhchk", "fareharbor.com", "#12", "Front desk"]) {
      expect(text).not.toContain(secret);
    }
    expect(b).toMatchObject({
      uuid: "b-1",
      status: "booked",
      company: "riverschool",
      itemPk: 1867,
      itemName: "Paddle Tour",
      startDate: "2026-07-22",
      startAt: "2026-07-22T15:30:00.000Z",
      receiptSubtotal: 20000,
      channel: "desk",
      customers: [{ type: "Adult", total: 21200, tax: 1200, checkin: "checked-in" }],
    });
    expect(b.payments[0]).toMatchObject({ createdAt: "2026-03-23T18:36:36.000Z", amountPaid: 21200, refunds: [{ amount: 5000 }] });
  });

  it("hashes what's stored, so an unchanged booking hashes the same", () => {
    expect(sanitizeBooking(fullBooking, "x")!.rowHash).toBe(sanitizeBooking({ ...fullBooking, note: "different" }, "x")!.rowHash);
    expect(sanitizeBooking(fullBooking, "x")!.rowHash).not.toBe(sanitizeBooking({ ...fullBooking, status: "cancelled" }, "x")!.rowHash);
  });

  it("reads FareHarbor datetimes", () => {
    expect(fhTime("2015-01-22T11:30:00-1000")).toBe("2015-01-22T21:30:00.000Z");
    expect(fhTime("2013-02-04T06:21:36+0000")).toBe("2013-02-04T06:21:36.000Z");
    expect(fhTime("nope")).toBeNull();
    expect(fhLocalDate("2026-10-31T23:30:00-0400")).toBe("2026-10-31");
  });

  it("splits date ranges into months with end after start", () => {
    expect(monthChunks("2026-01-15", "2026-03-01")).toEqual([
      ["2026-01-15", "2026-01-31"],
      ["2026-02-01", "2026-02-28"],
      ["2026-03-01", "2026-03-02"],
    ]);
  });
});

function setup(opts: { stored?: Map<string, string>; env?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const headers = init?.headers as Record<string, string>;
    if (headers["X-FareHarbor-API-App"] !== "app" || headers["X-FareHarbor-API-User"] !== "user") return new Response("no", { status: 401 });
    const p = url.pathname.replace("/v1", "");
    let body: unknown = null;
    if (p === "/companies/") body = { companies: [{ shortname: "riverschool", name: "River School", currency: "usd" }] };
    else if (p === "/companies/riverschool/items/") body = { items: [{ pk: 1867, name: "Paddle Tour", description: "long text" }] };
    else if (p.startsWith("/companies/riverschool/items/1867/minimal/availabilities/date-range/")) {
      const [from] = p.split("/").slice(-3);
      body = { availabilities: from === "2026-07-01" ? [{ pk: 4786, start_at: "2026-07-22T11:30:00-0400", end_at: "2026-07-22T13:30:00-0400", capacity: 10 }] : [] };
    } else if (p === "/companies/riverschool/availabilities/4786/bookings/")
      body = { bookings: [{ uuid: "b-1", status: "booked", contact: { name: "x" } }, { uuid: "b-2", status: "rebooked", contact: { email: "y@z" } }] };
    else if (p === "/companies/riverschool/bookings/b-1/") body = { booking: fullBooking };
    if (body === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const stored: StoredHashes = { load: async () => opts.stored ?? new Map() };
  const c = new FareharborConnector({
    secrets: new EnvSecretStore({ FAREHARBOR_APP_KEY: "app", FAREHARBOR_USER_KEY: "user", ...opts.env }),
    baseUrl: "https://fh.test/v1",
    historyStart: "2026-05-01",
    stored,
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-07-10T12:00:00Z"),
  });
  const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
  return { c, calls, deps };
}

describe("fareharbor sync", () => {
  it("walks companies → items → availabilities → bookings and saves progress", async () => {
    const { c, calls, deps } = setup();
    const result = await runSync(c, deps, "incremental");
    expect(result.status).toBe("ok");
    const ids = (e: string) => deps.writer.rows.filter((r) => r.record.entity === e).map((r) => r.record.recordId);
    expect(ids("companies")).toEqual(["riverschool"]);
    expect(ids("items")).toEqual(["riverschool:1867"]);
    expect(ids("availabilities")).toEqual(["riverschool:4786"]);
    expect(ids("bookings")).toEqual(["b-1", "b-2"]);
    // Rebooked bookings aren't fetched in full; payments are requested for the rest.
    expect(calls).toContain("/v1/companies/riverschool/bookings/b-1/?with_payments=yes");
    expect(calls.some((p) => p.includes("/bookings/b-2/"))).toBe(false);
    expect(JSON.stringify(deps.writer.rows)).not.toContain("Surfer");
    const cursors = (await deps.state.get("fareharbor")).cursors;
    expect(cursors["window:riverschool"]).toBe("2026-07-10T12:00:00.000Z");
    expect(cursors["window_pos:riverschool"]).toBe("");
    // History runs up to 35 days ago.
    expect(cursors["history:riverschool"]! >= "2026-05-29").toBe(true);
  });

  it("skips rows that haven't changed", async () => {
    const first = setup();
    await runSync(first.c, first.deps, "incremental");
    const stored = new Map<string, string>();
    for (const r of first.deps.writer.rows) {
      const p = r.record.payload as { rowHash?: string };
      if (p.rowHash) stored.set(r.record.entity === "availabilities" ? `a:${r.record.recordId}` : r.record.recordId, p.rowHash);
    }
    const second = setup({ stored });
    await runSync(second.c, second.deps, "incremental");
    expect(second.deps.writer.rows.filter((r) => ["bookings", "availabilities"].includes(r.record.entity))).toEqual([]);
  });

  it("reports not connected without keys", async () => {
    const { deps } = setup();
    const c = new FareharborConnector({ secrets: new EnvSecretStore({}), baseUrl: "https://fh.test/v1", historyStart: "2026-01-01", stored: { load: async () => new Map() } });
    const result = await runSync(c, deps, "incremental");
    expect(result).toMatchObject({ status: "ok", notConfigured: true });
  });
});

describe("fareharbor webhooks", () => {
  const req = (key: string, body: unknown) => ({ headers: {}, rawBody: Buffer.from(JSON.stringify(body)), url: `https://hooks.test/webhooks/fareharbor?key=${key}` });

  it("rejects a wrong key and re-reads the booking for a right one", async () => {
    const { c, calls } = setup({ env: { FAREHARBOR_WEBHOOK_KEY: "s3cret-key" } });
    await expect(c.handleWebhook(req("wrong", { booking: fullBooking }))).rejects.toBeInstanceOf(WebhookAuthError);
    const forged = { booking: { ...fullBooking, receipt_subtotal: 1 } };
    const records = await c.handleWebhook(req("s3cret-key", forged));
    expect(calls).toContain("/v1/companies/riverschool/bookings/b-1/?with_payments=yes");
    expect(records).toHaveLength(1);
    expect((records[0]!.payload as { receiptSubtotal: number }).receiptSubtotal).toBe(20000);
  });

  it("refuses webhooks until a key is stored", async () => {
    const { c } = setup();
    await expect(c.handleWebhook(req("", { booking: fullBooking }))).rejects.toBeInstanceOf(WebhookAuthError);
  });
});
