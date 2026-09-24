import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "../core/memory.js";
import { runSync } from "../core/runner.js";
import { EnvSecretStore } from "../core/secrets.js";
import { WebhookAuthError } from "../core/types.js";
import { normalizeShop, ShopifyConnector, verifyShopifyHmac } from "./shopify.js";

type Gql = { query: string; variables: Record<string, any> };
type Handler = (op: string, vars: Record<string, any>) => unknown;

const opName = (q: string) => /(query|mutation)\s+(\w+)/.exec(q)?.[2] ?? "";
const page = (nodes: unknown[], next: string | null = null) => ({ pageInfo: { hasNextPage: !!next, endCursor: next }, nodes });
const order = (id: string, updatedAt: string, lineItems = page([{ id: `${id}-L1` }])) => ({ id, updatedAt, lineItems });

function fake(handler: Handler, log: Array<{ op: string; vars: any }> = [], tokenCalls = { n: 0 }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/admin/oauth/access_token")) {
      tokenCalls.n++;
      const form = new URLSearchParams(String(init?.body));
      if (form.get("client_secret") !== "secret") return new Response('{"error":"invalid_client"}', { status: 401 });
      return new Response(JSON.stringify({ access_token: `tok${tokenCalls.n}`, expires_in: 86399 }), { status: 200 });
    }
    const { query, variables } = JSON.parse(String(init?.body)) as Gql;
    const op = opName(query);
    log.push({ op, vars: variables });
    const result = handler(op, variables);
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
}

const secrets = (extra: Record<string, string> = {}) =>
  new EnvSecretStore({ SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret", ...extra });

const deps = () => ({ writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() });

const emptyOthers: Record<string, unknown> = {
  Products: { data: { products: page([]) } },
  Inventory: { data: { inventoryItems: page([]) } },
  Webhooks: { data: { webhookSubscriptions: page([]) } },
};

function make(handler: Handler, log?: Array<{ op: string; vars: any }>, opts: { webhookUrl?: string; tokenCalls?: { n: number } } = {}) {
  return new ShopifyConnector({
    shop: "demo.myshopify.com",
    apiVersion: "2026-07",
    secrets: secrets(),
    webhookUrl: opts.webhookUrl,
    fetchImpl: fake(handler, log, opts.tokenCalls),
    sleep: async () => {},
  });
}

describe("shopify sync", () => {
  it("pages orders by updated_at, completes long line item lists, saves the cursor", async () => {
    const log: Array<{ op: string; vars: any }> = [];
    const c = make((op, vars) => {
      if (op === "Orders")
        return vars.after
          ? { data: { orders: page([order("gid://shopify/Order/2", "2026-09-02T00:00:00Z")]) } }
          : { data: { orders: page([order("gid://shopify/Order/1", "2026-09-01T00:00:00Z", page([{ id: "A" }], "li1"))], "p2") } };
      if (op === "OrderLineItems") return { data: { order: { lineItems: page([{ id: "B" }]) } } };
      return emptyOthers[op];
    }, log);
    const d = deps();
    const result = await runSync(c, d, "incremental");
    expect(result.status).toBe("ok");
    const orders = d.writer.rows.filter((r) => r.record.entity === "orders");
    expect(orders.map((r) => r.record.recordId)).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/2"]);
    expect((orders[0]!.record.payload as any).lineItems.nodes.map((n: any) => n.id)).toEqual(["A", "B"]);
    expect((await d.state.get("shopify")).cursors.orders).toBe("2026-09-02T00:00:00Z");
    const first = log.find((l) => l.op === "Orders")!.vars;
    expect(first.query).toBe("updated_at:>='1999-12-31T23:55:00.000Z'");
  });

  it("shrinks the page size when a query is too expensive", async () => {
    const sizes: number[] = [];
    const c = make((op, vars) => {
      if (op === "Orders") {
        sizes.push(vars.first);
        if (vars.first > 2) return { errors: [{ message: "too costly", extensions: { code: "MAX_COST_EXCEEDED" } }] };
        return { data: { orders: page([]) } };
      }
      return emptyOthers[op];
    });
    const result = await runSync(c, deps(), "incremental");
    expect(result.status).toBe("ok");
    expect(sizes).toEqual([5, 2]);
  });

  it("waits and retries when throttled", async () => {
    let calls = 0;
    const c = make((op) => {
      if (op === "Orders") {
        calls++;
        return calls === 1
          ? { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 10, restoreRate: 100 } } } }
          : { data: { orders: page([]) } };
      }
      return emptyOthers[op];
    });
    expect((await runSync(c, deps(), "incremental")).status).toBe("ok");
    expect(calls).toBe(2);
  });

  it("writes an inventory snapshot keyed by item and location, skipping untracked items", async () => {
    const c = make((op) => {
      if (op === "Orders") return { data: { orders: page([]) } };
      if (op === "Inventory")
        return {
          data: {
            inventoryItems: page([
              {
                id: "gid://shopify/InventoryItem/1", sku: "HD-M", tracked: true,
                variant: { id: "V1", title: "M", product: { id: "P1", title: "Hoodie" } },
                inventoryLevels: { nodes: [{ location: { id: "Loc1", name: "Shop" }, quantities: [{ name: "available", quantity: 4 }, { name: "on_hand", quantity: 6 }] }] },
              },
              { id: "gid://shopify/InventoryItem/2", sku: null, tracked: false, variant: null, inventoryLevels: { nodes: [] } },
            ]),
          },
        };
      return emptyOthers[op];
    });
    const d = deps();
    await runSync(c, d, "incremental");
    const inv = d.writer.rows.filter((r) => r.record.entity === "inventory_levels");
    expect(inv).toHaveLength(1);
    expect(inv[0]!.record.recordId).toBe("gid://shopify/InventoryItem/1|Loc1");
    expect(inv[0]!.record.payload).toMatchObject({ available: 4, onHand: 6, productTitle: "Hoodie", locationName: "Shop" });
    expect((await d.state.get("shopify")).cursors.inventory_snapshot_at).toBeTruthy();
  });

  it("creates missing webhook subscriptions once a day", async () => {
    const created: string[] = [];
    const c = make(
      (op, vars) => {
        if (op === "Orders") return { data: { orders: page([]) } };
        if (op === "Webhooks") return { data: { webhookSubscriptions: page([{ id: "W1", topic: "ORDERS_CREATE", uri: "https://hooks/webhooks/shopify" }]) } };
        if (op === "CreateWebhook") {
          created.push(vars.topic);
          return { data: { webhookSubscriptionCreate: { webhookSubscription: { id: "x" }, userErrors: [] } } };
        }
        return emptyOthers[op];
      },
      undefined,
      { webhookUrl: "https://hooks/webhooks/shopify" },
    );
    const d = deps();
    await runSync(c, d, "incremental");
    expect(created).toEqual(["ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE", "PRODUCTS_UPDATE"]);
    created.length = 0;
    await runSync(c, d, "incremental");
    expect(created).toEqual([]);
  });

  it("reuses the access token between calls", async () => {
    const tokenCalls = { n: 0 };
    const c = make((op) => (op === "Orders" ? { data: { orders: page([]) } } : emptyOthers[op]), undefined, { tokenCalls });
    await runSync(c, deps(), "incremental");
    expect(tokenCalls.n).toBe(1);
  });

  it("is 'not connected' without credentials or shop", async () => {
    const noSecrets = new ShopifyConnector({ shop: "demo.myshopify.com", apiVersion: "2026-07", secrets: new EnvSecretStore({}) });
    expect(await runSync(noSecrets, deps(), "incremental")).toMatchObject({ notConfigured: true });
    const noShop = new ShopifyConnector({ apiVersion: "2026-07", secrets: secrets() });
    expect(await runSync(noShop, deps(), "incremental")).toMatchObject({ notConfigured: true });
  });

  it("fails the run clearly on bad credentials", async () => {
    const c = new ShopifyConnector({
      shop: "demo.myshopify.com", apiVersion: "2026-07",
      secrets: new EnvSecretStore({ SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "wrong" }),
      fetchImpl: fake(() => ({})), sleep: async () => {},
    });
    const result = await runSync(c, deps(), "incremental");
    expect(result.status).toBe("error");
    expect(result.error).toContain("401");
  });
});

describe("shopify webhooks", () => {
  const sign = (body: string) => createHmac("sha256", "secret").update(body).digest("base64");

  it("verifies HMAC over the raw body", () => {
    expect(verifyShopifyHmac("secret", Buffer.from("{}"), sign("{}"))).toBe(true);
    expect(verifyShopifyHmac("secret", Buffer.from("{} "), sign("{}"))).toBe(false);
    expect(verifyShopifyHmac("secret", Buffer.from("{}"), undefined)).toBe(false);
  });

  it("re-fetches the order for order and refund events", async () => {
    const ids: string[] = [];
    const c = make((op, vars) => {
      if (op === "Order") {
        ids.push(vars.id);
        return { data: { order: order(vars.id, "2026-09-05T00:00:00Z") } };
      }
      return {};
    });
    const orderBody = JSON.stringify({ id: 7, admin_graphql_api_id: "gid://shopify/Order/7" });
    const refundBody = JSON.stringify({ id: 99, order_id: 8 });
    const a = await c.handleWebhook({ headers: { "x-shopify-hmac-sha256": sign(orderBody), "x-shopify-topic": "orders/updated" }, rawBody: Buffer.from(orderBody), url: "" });
    const b = await c.handleWebhook({ headers: { "x-shopify-hmac-sha256": sign(refundBody), "x-shopify-topic": "refunds/create" }, rawBody: Buffer.from(refundBody), url: "" });
    expect(ids).toEqual(["gid://shopify/Order/7", "gid://shopify/Order/8"]);
    expect([...a, ...b].map((r) => r.entity)).toEqual(["orders", "orders"]);
  });

  it("rejects forged deliveries", async () => {
    const c = make(() => ({}));
    await expect(
      c.handleWebhook({ headers: { "x-shopify-hmac-sha256": sign("other"), "x-shopify-topic": "orders/create" }, rawBody: Buffer.from("{}"), url: "" }),
    ).rejects.toBeInstanceOf(WebhookAuthError);
  });
});

describe("shop domain", () => {
  it("accepts the forms people paste", () => {
    expect(normalizeShop("calleva")).toBe("calleva.myshopify.com");
    expect(normalizeShop("Calleva.myshopify.com")).toBe("calleva.myshopify.com");
    expect(normalizeShop("https://calleva.myshopify.com/admin")).toBe("calleva.myshopify.com");
    expect(normalizeShop("https://admin.shopify.com/store/calleva/orders")).toBe("calleva.myshopify.com");
  });
});
