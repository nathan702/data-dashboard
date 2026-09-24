import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, requestJson } from "../core/http.js";
import { NotConfiguredError, requireSecret, type SecretStore } from "../core/secrets.js";
import { WebhookAuthError, type Connector, type RawRecord, type SyncContext, type WebhookRequest } from "../core/types.js";
import {
  INVENTORY_QUERY,
  ORDER_LINE_ITEMS_QUERY,
  ORDER_QUERY,
  ORDERS_QUERY,
  PRODUCT_QUERY,
  PRODUCTS_QUERY,
  WEBHOOK_CREATE_MUTATION,
  WEBHOOK_SUBSCRIPTIONS_QUERY,
} from "./shopifyQueries.js";

/**
 * Shopify (one store): orders with line items, refunds and fees; products;
 * hourly inventory snapshots. Uses a Dev Dashboard app with the client
 * credentials grant: tokens last ~24h and are simply re-requested.
 *
 * Webhooks are treated as "this changed" signals: the handler re-fetches the
 * object through GraphQL so raw rows always have the same shape.
 */
export const SHOPIFY_SHOP_SECRET = "shopify-shop";
export const SHOPIFY_CLIENT_ID_SECRET = "shopify-client-id";
export const SHOPIFY_CLIENT_SECRET_SECRET = "shopify-client-secret";

export const SHOPIFY_WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE", "PRODUCTS_UPDATE"];

export interface ShopifyConfig {
  /** e.g. "calleva.myshopify.com"; when unset, read from the shopify-shop secret. */
  shop?: string;
  apiVersion: string;
  secrets: SecretStore;
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const EPOCH = "2000-01-01T00:00:00Z";
const OVERLAP_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const INVENTORY_EVERY_MS = 60 * 60_000;
const DEFAULT_ORDER_PAGE = 5;

export function shopifyConfigFromEnv(env: NodeJS.ProcessEnv, secrets: SecretStore): ShopifyConfig {
  return {
    apiVersion: env.SHOPIFY_API_VERSION ?? "2026-07",
    secrets,
    webhookUrl: env.PUBLIC_WEBHOOK_BASE_URL ? `${env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/$/, "")}/webhooks/shopify` : undefined,
  };
}

export function verifyShopifyHmac(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
}

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly codes: string[],
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

type Node = { id: string; updatedAt?: string; [k: string]: unknown };
type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

const minusMs = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();

export class ShopifyConnector implements Connector {
  readonly source = "shopify" as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: ShopifyConfig) {
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private shopDomain: string | null = null;

  /** Accepts "name", "name.myshopify.com" or a full admin URL. */
  private async shop(): Promise<string> {
    if (this.shopDomain) return this.shopDomain;
    const raw = this.cfg.shop ?? (await this.cfg.secrets.get(SHOPIFY_SHOP_SECRET));
    if (!raw) throw new NotConfiguredError(`Shopify isn't connected yet: add the "${SHOPIFY_SHOP_SECRET}" secret`);
    this.shopDomain = normalizeShop(raw);
    return this.shopDomain;
  }

  /** Client credentials grant; cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const clientId = await requireSecret(this.cfg.secrets, SHOPIFY_CLIENT_ID_SECRET, "Shopify");
    const clientSecret = await requireSecret(this.cfg.secrets, SHOPIFY_CLIENT_SECRET_SECRET, "Shopify");
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const shop = await this.shop();
    const res = await doFetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, `https://${shop}/admin/oauth/access_token`);
    const body = JSON.parse(text) as { access_token: string; expires_in?: number };
    const ttlMs = (body.expires_in ?? 86_400) * 1000;
    this.token = { value: body.access_token, expiresAt: Date.now() + ttlMs - 10 * 60_000 };
    return body.access_token;
  }

  /** One GraphQL call, waiting out throttling using Shopify's reported bucket state. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      let res: GqlResponse<T>;
      try {
        res = await requestJson<GqlResponse<T>>(`https://${await this.shop()}/admin/api/${this.cfg.apiVersion}/graphql.json`, {
          body: { query, variables },
          headers: { "X-Shopify-Access-Token": token },
          fetchImpl: this.cfg.fetchImpl,
          sleep: this.cfg.sleep,
        });
      } catch (err) {
        // Expired or revoked token: get a new one once.
        if (err instanceof HttpError && err.status === 401 && attempt === 0) {
          this.token = null;
          continue;
        }
        throw err;
      }
      const cost = res.extensions?.cost;
      const codes = (res.errors ?? []).map((e) => e.extensions?.code ?? "");
      if (codes.includes("THROTTLED") && attempt < 8) {
        await this.sleep(this.waitMs(cost));
        continue;
      }
      if (res.errors?.length) throw new ShopifyGraphqlError(res.errors.map((e) => e.message).join("; "), codes);
      // Slow down before the bucket runs dry rather than after.
      const available = cost?.throttleStatus?.currentlyAvailable;
      if (available !== undefined && cost?.requestedQueryCost && available < cost.requestedQueryCost * 2) {
        await this.sleep(this.waitMs(cost));
      }
      return res.data as T;
    }
  }

  private waitMs(cost: NonNullable<GqlResponse<unknown>["extensions"]>["cost"]): number {
    const need = (cost?.requestedQueryCost ?? 100) * 2 - (cost?.throttleStatus?.currentlyAvailable ?? 0);
    const rate = cost?.throttleStatus?.restoreRate || 50;
    return Math.min(Math.max(need / rate, 1) * 1000, 30_000);
  }

  async sync(ctx: SyncContext) {
    // Fail fast with "not connected" before doing anything else.
    await this.shop();
    await requireSecret(this.cfg.secrets, SHOPIFY_CLIENT_ID_SECRET, "Shopify");
    await requireSecret(this.cfg.secrets, SHOPIFY_CLIENT_SECRET_SECRET, "Shopify");
    await this.ensureWebhooks(ctx);
    await this.syncOrders(ctx);
    if (ctx.outOfTime()) return;
    await this.syncProducts(ctx);
    if (ctx.outOfTime()) return;
    await this.snapshotInventory(ctx);
  }

  private async syncOrders(ctx: SyncContext) {
    const since = ctx.state.cursors.orders ?? EPOCH;
    const search = `updated_at:>='${minusMs(since, OVERLAP_MS)}'`;
    let after: string | null = null;
    let first = DEFAULT_ORDER_PAGE;
    let newest: string | undefined;
    for (;;) {
      let page: Page<Node>;
      try {
        ({ orders: page } = await this.graphql<{ orders: Page<Node> }>(ORDERS_QUERY, { first, after, query: search }));
      } catch (err) {
        // Retry the same page smaller if Shopify says the query is too expensive.
        if (err instanceof ShopifyGraphqlError && err.codes.includes("MAX_COST_EXCEEDED") && first > 1) {
          first = Math.max(1, Math.floor(first / 2));
          continue;
        }
        throw err;
      }
      const orders = await Promise.all(page.nodes.map((o) => this.completeLineItems(o)));
      await ctx.emit(orders.map((o) => toRecord("orders", o)));
      for (const o of orders) if (o.updatedAt && (!newest || o.updatedAt > newest)) newest = o.updatedAt;
      // Sorted by updated_at, so progress can be saved after every page.
      if (newest) await ctx.saveCursor("orders", newest);
      if (orders.length) ctx.log("shopify orders page", { count: orders.length, through: newest });
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (!after || ctx.outOfTime()) break;
    }
  }

  /** Orders with more line items than fit in one page get the rest fetched separately. */
  private async completeLineItems(order: Node): Promise<Node> {
    const li = order.lineItems as Page<unknown> | undefined;
    if (!li?.pageInfo?.hasNextPage) return order;
    const nodes = [...li.nodes];
    let after = li.pageInfo.endCursor;
    while (after) {
      const res: { order: { lineItems: Page<unknown> } | null } = await this.graphql(ORDER_LINE_ITEMS_QUERY, { id: order.id, after });
      const more = res.order?.lineItems;
      if (!more) break;
      nodes.push(...more.nodes);
      after = more.pageInfo.hasNextPage ? more.pageInfo.endCursor : null;
    }
    return { ...order, lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
  }

  private async syncProducts(ctx: SyncContext) {
    const since = ctx.state.cursors.products ?? EPOCH;
    let after: string | null = null;
    let newest: string | undefined;
    do {
      const res: { products: Page<Node> } = await this.graphql(PRODUCTS_QUERY, { after, query: `updated_at:>='${minusMs(since, OVERLAP_MS)}'` });
      await ctx.emit(res.products.nodes.map((p) => toRecord("products", p)));
      for (const p of res.products.nodes) if (p.updatedAt && (!newest || p.updatedAt > newest)) newest = p.updatedAt;
      if (newest) await ctx.saveCursor("products", newest);
      after = res.products.pageInfo.hasNextPage ? res.products.pageInfo.endCursor : null;
    } while (after && !ctx.outOfTime());
  }

  /**
   * Current stock per variant and location, at most hourly. Each row's
   * version time is the snapshot time, so the latest version is current stock
   * and older versions form the stock history.
   */
  private async snapshotInventory(ctx: SyncContext) {
    const last = ctx.state.cursors.inventory_snapshot_at;
    if (last && Date.now() - Date.parse(last) < INVENTORY_EVERY_MS) return;
    const snapshotAt = new Date();
    let after: string | null = null;
    let rows = 0;
    do {
      type Item = {
        id: string;
        sku: string | null;
        tracked: boolean;
        variant: { id: string; title: string; product: { id: string; title: string } } | null;
        inventoryLevels: { nodes: Array<{ location: { id: string; name: string }; quantities: Array<{ name: string; quantity: number }> }> };
      };
      const res: { inventoryItems: Page<Item> } = await this.graphql(INVENTORY_QUERY, { after });
      const records: RawRecord[] = [];
      for (const item of res.inventoryItems.nodes) {
        if (!item.tracked || !item.variant) continue;
        for (const level of item.inventoryLevels.nodes) {
          const q = Object.fromEntries(level.quantities.map((x) => [x.name, x.quantity]));
          records.push({
            entity: "inventory_levels",
            recordId: `${item.id}|${level.location.id}`,
            sourceUpdatedAt: snapshotAt,
            payload: {
              snapshotAt: snapshotAt.toISOString(),
              inventoryItemId: item.id,
              sku: item.sku,
              variantId: item.variant.id,
              variantTitle: item.variant.title,
              productId: item.variant.product.id,
              productTitle: item.variant.product.title,
              locationId: level.location.id,
              locationName: level.location.name,
              available: q.available ?? 0,
              onHand: q.on_hand ?? 0,
            },
          });
        }
      }
      rows += await ctx.emit(records);
      after = res.inventoryItems.pageInfo.hasNextPage ? res.inventoryItems.pageInfo.endCursor : null;
    } while (after && !ctx.outOfTime());
    // Only a complete snapshot counts; a partial one is retried next run.
    if (!after) await ctx.saveCursor("inventory_snapshot_at", snapshotAt.toISOString());
    ctx.log("shopify inventory snapshot", { rows, complete: !after });
  }

  /** Make sure our webhook subscriptions exist; checked daily (Shopify drops failing ones). */
  async ensureWebhooks(ctx: SyncContext) {
    const uri = this.cfg.webhookUrl;
    const last = ctx.state.cursors.webhooks_checked_at;
    if (!uri || (last && Date.now() - Date.parse(last) < DAY_MS)) return;
    try {
      const existing = new Set<string>();
      let after: string | null = null;
      do {
        const res: { webhookSubscriptions: Page<{ id: string; topic: string; uri: string }> } = await this.graphql(WEBHOOK_SUBSCRIPTIONS_QUERY, { after });
        for (const w of res.webhookSubscriptions.nodes) if (w.uri === uri) existing.add(w.topic);
        after = res.webhookSubscriptions.pageInfo.hasNextPage ? res.webhookSubscriptions.pageInfo.endCursor : null;
      } while (after);
      for (const topic of SHOPIFY_WEBHOOK_TOPICS.filter((t) => !existing.has(t))) {
        const res: { webhookSubscriptionCreate: { userErrors: Array<{ message: string }> } } = await this.graphql(WEBHOOK_CREATE_MUTATION, { topic, uri });
        const errs = res.webhookSubscriptionCreate.userErrors;
        if (errs.length) throw new Error(`${topic}: ${errs.map((e) => e.message).join("; ")}`);
        ctx.log("created Shopify webhook", { topic });
      }
      await ctx.saveCursor("webhooks_checked_at", new Date().toISOString());
    } catch (err) {
      ctx.log("could not verify Shopify webhooks; will retry next run", { error: String(err) });
    }
  }

  async handleWebhook(req: WebhookRequest): Promise<RawRecord[]> {
    const secret = await this.cfg.secrets.get(SHOPIFY_CLIENT_SECRET_SECRET);
    if (!secret) throw new WebhookAuthError("Shopify is not configured");
    if (!verifyShopifyHmac(secret, req.rawBody, req.headers["x-shopify-hmac-sha256"])) throw new WebhookAuthError();
    const topic = (req.headers["x-shopify-topic"] ?? "").toLowerCase();
    const body = JSON.parse(req.rawBody.toString("utf8")) as { admin_graphql_api_id?: string; order_id?: number | string };

    if (topic.startsWith("orders/") || topic === "refunds/create") {
      const id = topic === "refunds/create" ? (body.order_id ? `gid://shopify/Order/${body.order_id}` : undefined) : body.admin_graphql_api_id;
      if (!id) return [];
      const res: { order: Node | null } = await this.graphql(ORDER_QUERY, { id });
      return res.order ? [toRecord("orders", await this.completeLineItems(res.order))] : [];
    }
    if (topic === "products/update" || topic === "products/create") {
      if (!body.admin_graphql_api_id) return [];
      const res: { product: Node | null } = await this.graphql(PRODUCT_QUERY, { id: body.admin_graphql_api_id });
      return res.product ? [toRecord("products", res.product)] : [];
    }
    return [];
  }
}

export function normalizeShop(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // admin.shopify.com/store/<name> links
  const m = /admin\.shopify\.com\/store\/([a-z0-9-]+)/.exec(raw.toLowerCase());
  if (m) s = m[1]!;
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

function toRecord(entity: string, n: Node): RawRecord {
  return { entity, recordId: n.id, sourceUpdatedAt: n.updatedAt ? new Date(n.updatedAt) : undefined, payload: n };
}
