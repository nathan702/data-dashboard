import { describe, expect, it } from "vitest";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "../core/memory.js";
import { runSync } from "../core/runner.js";
import { EnvSecretStore } from "../core/secrets.js";
import { hsDate, hsTime, HubspotConnector, sanitizeDeal } from "./hubspot.js";

const deal = (id: string, modified: string, extra: Record<string, unknown> = {}) => ({
  id,
  properties: {
    dealname: "Smith Elementary 4th grade trip",
    pipeline: "p1",
    dealstage: "won",
    amount: "1250.50",
    deal_currency_code: "USD",
    closedate: "2026-03-01T15:00:00Z",
    createdate: "2026-01-10T15:00:00Z",
    hs_lastmodifieddate: modified,
    hs_is_closed: "true",
    hs_is_closed_won: "true",
    program_date: "2026-05-14",
    student_count: "48",
    teacher_email: "teacher@school.org",
    ...extra,
  },
});

const PROPS = [
  { name: "dealname", type: "string", hubspotDefined: true },
  { name: "program_date", label: "Program date", type: "date" },
  { name: "student_count", label: "Students", type: "number" },
  { name: "teacher_email", label: "Teacher email", type: "string" },
  { name: "lead_notes", label: "Notes", type: "string" },
  { name: "days_to_close", type: "number", hubspotDefined: true },
];

function setup(opts: { deals?: Array<ReturnType<typeof deal>>; serviceDateProperty?: string; token?: string } = {}) {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const deals = opts.deals ?? [deal("1", "2026-03-02T00:00:00Z"), deal("2", "2026-03-03T00:00:00Z", { hs_is_closed_won: "false", hs_is_closed: "false", dealstage: "open" })];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, body });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url.pathname === "/crm/v3/pipelines/deals")
      return json({ results: [{ id: "p1", label: "Field trips", stages: [{ id: "won", label: "Closed won", displayOrder: 3, metadata: { isClosed: "true", probability: "1.0" } }] }] });
    if (url.pathname === "/crm/v3/properties/deals") return json({ results: PROPS });
    if (url.pathname === "/crm/v3/objects/deals/search") {
      const since = Number(body.filterGroups[0].filters[0].value);
      const rows = deals.filter((d) => Date.parse(d.properties.hs_lastmodifieddate) >= since);
      const start = Number(body.after ?? 0);
      const page = rows.slice(start, start + body.limit);
      return json({ results: page, ...(start + body.limit < rows.length ? { paging: { next: { after: String(start + body.limit) } } } : {}) });
    }
    if (url.pathname === "/crm/v3/objects/deals" && url.searchParams.get("archived") === "true") return json({ results: [{ id: "9" }] });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const c = new HubspotConnector({
    secrets: new EnvSecretStore(opts.token === "" ? {} : { HUBSPOT_PRIVATE_APP_TOKEN: opts.token ?? "tok" }),
    baseUrl: "https://hs.test",
    serviceDateProperty: opts.serviceDateProperty,
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-04-01T12:00:00Z"),
  });
  const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
  return { c, calls, deps };
}

describe("hubspot parsing", () => {
  it("keeps pipeline, stage, money, dates and custom dates/numbers, never names or text", () => {
    const d = sanitizeDeal(deal("1", "2026-03-02T00:00:00Z"), [
      { name: "program_date", label: "Program date", type: "date" },
      { name: "student_count", label: "Students", type: "number" },
    ], "program_date")!;
    expect(JSON.stringify(d)).not.toMatch(/Smith|teacher|school\.org/);
    expect(d).toMatchObject({
      id: "1",
      pipeline: "p1",
      stage: "won",
      amount: 1250.5,
      isWon: true,
      closeDate: "2026-03-01",
      serviceDate: "2026-05-14",
      custom: { program_date: "2026-05-14", student_count: 48 },
    });
  });

  it("reads HubSpot dates", () => {
    expect(hsTime("1767225600000")).toBe("2026-01-01T00:00:00.000Z");
    expect(hsDate("2026-07-04T02:00:00Z")).toBe("2026-07-03");
    expect(hsDate("2026-07-04")).toBe("2026-07-04");
    expect(hsTime("")).toBeNull();
  });
});

describe("hubspot sync", () => {
  it("reads pipelines and deals modified since the last run, and deleted deals daily", async () => {
    const { c, calls, deps } = setup({ serviceDateProperty: "program_date" });
    const r = await runSync(c, deps, "incremental");
    expect(r.status).toBe("ok");
    const ids = (e: string) => deps.writer.rows.filter((x) => x.record.entity === e && !x.record.isDeleted).map((x) => x.record.recordId);
    expect(ids("pipelines")).toEqual(["p1"]);
    expect(ids("deals")).toEqual(["1", "2"]);
    expect(deps.writer.rows.filter((x) => x.record.isDeleted).map((x) => x.record.recordId)).toEqual(["9"]);
    // Only dates and numbers among custom properties are asked for; never text or names.
    const search = calls.find((x) => x.path.startsWith("/crm/v3/objects/deals/search"))!;
    expect(search.body!.properties).toEqual(expect.arrayContaining(["program_date", "student_count", "amount"]));
    expect(search.body!.properties).not.toEqual(expect.arrayContaining(["dealname"]));
    expect(search.body!.properties).not.toContain("teacher_email");
    expect(JSON.stringify(deps.writer.rows)).not.toMatch(/Smith|teacher/);
    const cursors = (await deps.state.get("hubspot")).cursors;
    expect(cursors.deals_modified).toBe("2026-03-03T00:00:00.000Z");

    // Next run: only deals modified since (with a little overlap); deleted deals aren't re-checked the same day.
    calls.length = 0;
    await runSync(c, deps, "incremental");
    const again = calls.find((x) => x.path.startsWith("/crm/v3/objects/deals/search"))!;
    expect(Number((again.body!.filterGroups as Array<{ filters: Array<{ value: string }> }>)[0]!.filters[0]!.value)).toBe(Date.parse("2026-03-03T00:00:00Z") - 5 * 60_000);
    expect(calls.some((x) => x.path.includes("archived=true"))).toBe(false);
  });

  it("pages through results", async () => {
    const many = Array.from({ length: 250 }, (_, i) => deal(String(i), new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()));
    const { c, deps } = setup({ deals: many });
    await runSync(c, deps, "incremental");
    expect(new Set(deps.writer.rows.filter((x) => x.record.entity === "deals" && !x.record.isDeleted).map((x) => x.record.recordId)).size).toBe(250);
  });

  it("refuses a program-date property that doesn't exist, and waits for a token", async () => {
    const bad = setup({ serviceDateProperty: "nope" });
    expect((await runSync(bad.c, bad.deps, "incremental")).error).toContain('no custom date property named "nope"');
    const none = setup({ token: "" });
    expect(await runSync(none.c, none.deps, "incremental")).toMatchObject({ status: "ok", notConfigured: true });
  });
});
