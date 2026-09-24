import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "../core/memory.js";
import { runSync } from "../core/runner.js";
import { EnvSecretStore } from "../core/secrets.js";
import { WebhookAuthError } from "../core/types.js";
import { SquareConnector, verifySquareSignature } from "./square.js";

type Handler = (url: URL, body: any) => unknown;

type Call = { path: string; body: any; query?: URLSearchParams };

function fakeFetch(routes: Record<string, Handler>, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, body, query: url.searchParams });
    const h = routes[url.pathname];
    if (!h) return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
    return new Response(JSON.stringify(h(url, body)), { status: 200 });
  }) as typeof fetch;
}

const order = (id: string, updated: string) => ({ id, location_id: "L1", state: "COMPLETED", updated_at: updated, created_at: updated });

function connector(routes: Record<string, Handler>, calls: Call[] = [], extra: { webhookUrl?: string; env?: Record<string, string> } = {}) {
  return new SquareConnector({
    secrets: new EnvSecretStore({ SQUARE_ACCESS_TOKEN: "tok", ...extra.env }),
    apiVersion: "2026-07-15",
    baseUrl: "https://sq.test",
    webhookUrl: extra.webhookUrl,
    fetchImpl: fakeFetch(routes, calls),
  });
}

const baseRoutes: Record<string, Handler> = {
  "/v2/locations": () => ({ locations: [{ id: "L1", name: "Boathouse" }] }),
  "/v2/catalog/search": () => ({ objects: [{ id: "V1", type: "ITEM_VARIATION", updated_at: "2026-09-01T00:00:00Z" }] }),
  "/v2/payments": () => ({ payments: [{ id: "P1", created_at: "2026-09-02T00:00:00Z", status: "COMPLETED" }] }),
  "/v2/refunds": () => ({ refunds: [] }),
};

describe("square sync", () => {
  it("pages through orders and saves cursors for the next run", async () => {
    const calls: Call[] = [];
    const c = connector(
      {
        ...baseRoutes,
        "/v2/orders/search": (_u, body) =>
          body.cursor ? { orders: [order("O2", "2026-09-03T00:00:00Z")] } : { orders: [order("O1", "2026-09-02T00:00:00Z")], cursor: "next" },
      },
      calls,
    );
    const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
    const result = await runSync(c, deps, "incremental");
    expect(result.status).toBe("ok");
    const byEntity = (e: string) => deps.writer.rows.filter((r) => r.record.entity === e).map((r) => r.record.recordId);
    expect(byEntity("orders")).toEqual(["O1", "O2"]);
    expect(byEntity("locations")).toEqual(["L1"]);
    expect(byEntity("catalog_objects")).toEqual(["V1"]);
    expect(byEntity("payments")).toEqual(["P1"]);
    const st = await deps.state.get("square");
    expect(st.cursors.orders).toBe("2026-09-03T00:00:00Z");
    expect(st.cursors.catalog).toBe("2026-09-01T00:00:00Z");

    // First run reads all history; the order search is sorted by updated_at.
    const firstSearch = calls.find((c) => c.path === "/v2/orders/search")!.body;
    expect(firstSearch.query.sort).toEqual({ sort_field: "UPDATED_AT", sort_order: "ASC" });
    expect(firstSearch.location_ids).toEqual(["L1"]);
    // Payments are listed per location, by updated_at, over all history.
    const pay = calls.find((c) => c.path === "/v2/payments")!.query!;
    expect(pay.get("location_id")).toBe("L1");
    expect(pay.get("sort_field")).toBe("UPDATED_AT");
    expect(pay.get("updated_at_begin_time")).toBe("2000-01-01T00:00:00Z");
    expect(st.cursors["payments:L1"]).toBe("2026-09-02T00:00:00Z");
    expect(firstSearch.query.filter.state_filter.states).not.toContain("DRAFT");
  });

  it("starts the next run from the saved cursor, minus an overlap", async () => {
    const calls: Call[] = [];
    const c = connector({ ...baseRoutes, "/v2/orders/search": () => ({ orders: [] }) }, calls);
    const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
    await deps.state.setCursor("square", "orders", "2026-09-10T12:00:00Z");
    await runSync(c, deps, "incremental");
    const search = calls.find((c) => c.path === "/v2/orders/search")!.body;
    expect(search.query.filter.date_time_filter.updated_at.start_at).toBe("2026-09-10T11:55:00.000Z");
  });

  it("stops before the long order import when out of time", async () => {
    let pages = 0;
    const c = connector({
      ...baseRoutes,
      "/v2/orders/search": () => {
        pages++;
        return { orders: [order(`O${pages}`, `2026-09-0${pages}T00:00:00Z`)], cursor: "more" };
      },
    });
    const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
    const result = await runSync(c, deps, "incremental", -1); // budget already used up
    expect(result.status).toBe("ok");
    expect(pages).toBe(0);
  });

  it("records API failures as a failed run", async () => {
    const bad = new SquareConnector({
      secrets: new EnvSecretStore({ SQUARE_ACCESS_TOKEN: "tok" }), apiVersion: "x", baseUrl: "https://sq.test",
      fetchImpl: (async () => new Response('{"errors":[{"code":"UNAUTHORIZED"}]}', { status: 401 })) as typeof fetch,
    });
    const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
    const result = await runSync(bad, deps, "incremental");
    expect(result.status).toBe("error");
    expect(result.error).toContain("401");
  });
});

describe("square webhooks", () => {
  const key = "sig-key";
  const url = "https://hooks.example/webhooks/square";
  const sign = (body: string) => createHmac("sha256", key).update(url + body).digest("base64");

  it("verifies signatures over URL + body", () => {
    const body = '{"a":1}';
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: Buffer.from(body), signature: sign(body) })).toBe(true);
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url + "x", rawBody: Buffer.from(body), signature: sign(body) })).toBe(false);
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: Buffer.from(body), signature: undefined })).toBe(false);
  });

  it("fetches the full order for order events", async () => {
    const calls: Call[] = [];
    const c = connector({ "/v2/orders/batch-retrieve": (_u, b) => ({ orders: b.order_ids.map((id: string) => order(id, "2026-09-05T00:00:00Z")) }) }, calls, {
      webhookUrl: url,
      env: { SQUARE_WEBHOOK_SIGNATURE_KEY: key },
    });
    const body = JSON.stringify({ type: "order.updated", data: { type: "order_updated", id: "O9", object: { order_updated: { order_id: "O9" } } } });
    const records = await c.handleWebhook({ headers: { "x-square-hmacsha256-signature": sign(body) }, rawBody: Buffer.from(body), url });
    expect(records.map((r) => [r.entity, r.recordId])).toEqual([["orders", "O9"]]);
  });

  it("stores payment objects straight from the event", async () => {
    const c = connector({}, [], { webhookUrl: url, env: { SQUARE_WEBHOOK_SIGNATURE_KEY: key } });
    const body = JSON.stringify({ type: "payment.updated", data: { type: "payment", id: "P5", object: { payment: { id: "P5", status: "COMPLETED", updated_at: "2026-09-05T00:00:00Z" } } } });
    const records = await c.handleWebhook({ headers: { "x-square-hmacsha256-signature": sign(body) }, rawBody: Buffer.from(body), url });
    expect(records[0]).toMatchObject({ entity: "payments", recordId: "P5" });
  });

  it("rejects bad signatures and unconfigured webhooks", async () => {
    const c = connector({}, [], { webhookUrl: url, env: { SQUARE_WEBHOOK_SIGNATURE_KEY: key } });
    await expect(c.handleWebhook({ headers: { "x-square-hmacsha256-signature": "nope" }, rawBody: Buffer.from("{}"), url })).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(connector({}).handleWebhook({ headers: {}, rawBody: Buffer.from("{}"), url })).rejects.toBeInstanceOf(WebhookAuthError);
  });
});

describe("square setup", () => {
  it("reports not connected (not failed) without an access token", async () => {
    const c = new SquareConnector({ secrets: new EnvSecretStore({}), apiVersion: "x", baseUrl: "https://sq.test" });
    const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
    const result = await runSync(c, deps, "incremental");
    expect(result).toMatchObject({ status: "ok", notConfigured: true });
    expect((await deps.state.get("square")).lastRunStatus).toBeNull();
    expect(deps.runLog.entries).toHaveLength(0);
  });

  it("creates the webhook subscription once and stores its signing key", async () => {
    const env: Record<string, string> = { SQUARE_ACCESS_TOKEN: "tok" };
    const secrets = new EnvSecretStore(env);
    const calls: Call[] = [];
    const routes: Record<string, Handler> = {
      ...baseRoutes,
      "/v2/orders/search": () => ({ orders: [] }),
      "/v2/webhooks/subscriptions": (_u, body) =>
        body ? { subscription: { id: "S1", signature_key: "new-key" } } : { subscriptions: [] },
    };
    const c = new SquareConnector({ secrets, apiVersion: "2026-07-15", baseUrl: "https://sq.test", webhookUrl: "https://hooks/webhooks/square", fetchImpl: fakeFetch(routes, calls) });
    const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
    await runSync(c, deps, "incremental");
    expect(env.SQUARE_WEBHOOK_SIGNATURE_KEY).toBe("new-key");
    const create = calls.find((x) => x.path === "/v2/webhooks/subscriptions" && x.body)!.body;
    expect(create.subscription.notification_url).toBe("https://hooks/webhooks/square");
    expect(create.subscription.event_types).toContain("payment.updated");
    // Checked again only after a day.
    const before = calls.length;
    await runSync(c, deps, "incremental");
    expect(calls.slice(before).some((x) => x.path.startsWith("/v2/webhooks"))).toBe(false);
  });
});
