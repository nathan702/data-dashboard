import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Source } from "@dash/shared";
import { createApp } from "./app.js";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "./core/memory.js";
import { WebhookAuthError, type Connector } from "./core/types.js";
import { toRawRow, rawTableName } from "./core/bigquery.js";
import { pickAllowed, pseudonymize } from "./core/privacy.js";

function setup(connector: Connector, role: "jobs" | "webhooks" | "all" = "all") {
  const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
  const connectors = new Map<Source, Connector>([[connector.source, connector]]);
  return { deps, app: createApp({ role, deps, connectors }) };
}

const fake: Connector = {
  source: "shopify",
  async sync(ctx) {
    const since = ctx.state.cursors.orders ?? "0";
    await ctx.emit([{ entity: "orders", recordId: `o-${since}`, payload: { since } }]);
    await ctx.saveCursor("orders", String(Number(since) + 1));
  },
  async handleWebhook(req) {
    if (req.headers["x-test-signature"] !== "good") throw new WebhookAuthError();
    return [{ entity: "orders", recordId: "wh-1", payload: JSON.parse(req.rawBody.toString()) }];
  },
};

describe("scheduled sync", () => {
  it("writes records, advances cursors and records freshness", async () => {
    const { app, deps } = setup(fake);
    await request(app).post("/run/shopify").expect(200);
    await request(app).post("/run/shopify").expect(200);
    expect(deps.writer.rows.map((r) => r.record.recordId)).toEqual(["o-0", "o-1"]);
    const st = await deps.state.get("shopify");
    expect(st.cursors.orders).toBe("2");
    expect(st.lastRunStatus).toBe("ok");
    expect(st.lastDataAt).not.toBeNull();
    expect(deps.runLog.entries).toHaveLength(2);
  });

  it("records failures without crashing and returns 500 for scheduler retry", async () => {
    const { app, deps } = setup({ source: "square", sync: async () => { throw new Error("boom"); } });
    const res = await request(app).post("/run/square").expect(500);
    expect(res.body.error).toBe("boom");
    expect((await deps.state.get("square")).lastError).toBe("boom");
    expect(deps.runLog.entries[0]?.status).toBe("error");
  });

  it("skips a run while another holds the source", async () => {
    const { app, deps } = setup(fake);
    await deps.state.tryStartRun("shopify", "other-run", 60_000);
    const res = await request(app).post("/run/shopify").expect(200);
    expect(res.body.skipped).toBe(true);
    expect(deps.writer.rows).toHaveLength(0);
  });

  it("marks backfill writes with the backfill path", async () => {
    const { app, deps } = setup(fake);
    await request(app).post("/run/shopify?mode=backfill").expect(200);
    expect(deps.writer.rows[0]?.path).toBe("backfill");
  });

  it("rejects unknown and unconfigured sources", async () => {
    const { app } = setup(fake);
    await request(app).post("/run/nope").expect(404);
    await request(app).post("/run/hubspot").expect(404);
  });

  it("does not expose job routes on the public webhooks service", async () => {
    const { app } = setup(fake, "webhooks");
    await request(app).post("/run/shopify").expect(404);
  });
});

describe("webhooks", () => {
  it("stores verified deliveries", async () => {
    const { app, deps } = setup(fake, "webhooks");
    await request(app)
      .post("/webhooks/shopify")
      .set("x-test-signature", "good")
      .set("content-type", "application/json")
      .send(JSON.stringify({ id: 1 }))
      .expect(200);
    expect(deps.writer.rows[0]).toMatchObject({ path: "webhook", record: { payload: { id: 1 } } });
  });

  it("rejects bad signatures with 401 and stores nothing", async () => {
    const { app, deps } = setup(fake, "webhooks");
    await request(app).post("/webhooks/shopify").set("x-test-signature", "bad").send("{}").expect(401);
    expect(deps.writer.rows).toHaveLength(0);
  });
});

describe("raw rows", () => {
  it("serializes payloads and defaults source_updated_at to ingest time", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const row = toRawRow({ entity: "orders", recordId: "1", payload: { a: 1 } }, "poll", "run", now);
    expect(row).toMatchObject({ record_id: "1", source_updated_at: now.toISOString(), is_deleted: false, payload: '{"a":1}' });
  });
  it("sanitizes table names", () => {
    expect(rawTableName("Order-Lines")).toBe("order_lines");
    expect(() => rawTableName("1bad")).toThrow();
  });
});

describe("privacy", () => {
  const key = "k".repeat(32);
  it("hashes identifiers consistently and case-insensitively", () => {
    expect(pseudonymize("A@B.com ", key)).toBe(pseudonymize("a@b.com", key));
    expect(pseudonymize("a@b.com", key)).not.toContain("a@b");
    expect(pseudonymize("", key)).toBeNull();
  });
  it("refuses weak keys", () => {
    expect(() => pseudonymize("x", "short")).toThrow();
  });
  it("keeps only allow-listed fields", () => {
    expect(pickAllowed({ grade: 5, name: "Kid", email: "x" }, ["grade"])).toEqual({ grade: 5 });
  });
});
