import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { requestJson } from "../core/http.js";
import { requireSecret, type SecretStore } from "../core/secrets.js";
import { WebhookAuthError, type Connector, type RawRecord, type SyncContext, type WebhookRequest } from "../core/types.js";

/**
 * Square: locations, catalog (items, variations, categories), orders,
 * payments and refunds. Money stays in Square's integer cents; staging
 * models convert to dollars.
 *
 * Webhooks only tell us *that* something changed; the handler stores the
 * full object in the same shape the scheduled sync fetches, so staging
 * models only ever see one format.
 */
export interface SquareConfig {
  secrets: SecretStore;
  apiVersion: string;
  baseUrl: string;
  /** Public URL of our webhook endpoint; also part of the signed payload. */
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}

export const SQUARE_TOKEN_SECRET = "square-access-token";
export const SQUARE_SIGNATURE_SECRET = "square-webhook-signature-key";

export const SQUARE_WEBHOOK_EVENTS = [
  "order.created",
  "order.updated",
  "payment.created",
  "payment.updated",
  "refund.created",
  "refund.updated",
];

const DAY_MS = 24 * 60 * 60_000;

/** Everything before this is fetched on the first run (i.e. all history). */
const EPOCH = "2000-01-01T00:00:00Z";
/** Re-read a window before each cursor so late-arriving updates aren't missed. */
const OVERLAP_MS = 5 * 60_000;
const MAX_LOCATIONS_PER_SEARCH = 10;

type Money = { amount?: number; currency?: string };
interface SquareObject {
  id: string;
  updated_at?: string;
  created_at?: string;
  is_deleted?: boolean;
  [k: string]: unknown;
}

export function squareConfigFromEnv(env: NodeJS.ProcessEnv, secrets: SecretStore): SquareConfig {
  return {
    secrets,
    apiVersion: env.SQUARE_API_VERSION ?? "2026-07-15",
    baseUrl: env.SQUARE_BASE_URL ?? "https://connect.squareup.com",
    webhookUrl: env.PUBLIC_WEBHOOK_BASE_URL ? `${env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/$/, "")}/webhooks/square` : undefined,
  };
}

export function minusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) - ms).toISOString();
}

export function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function verifySquareSignature(opts: { signatureKey: string; notificationUrl: string; rawBody: Buffer; signature: string | undefined }) {
  if (!opts.signature) return false;
  const expected = createHmac("sha256", opts.signatureKey).update(opts.notificationUrl).update(opts.rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(opts.signature, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const toRecord = (entity: string, o: SquareObject): RawRecord => ({
  entity,
  recordId: o.id,
  sourceUpdatedAt: o.updated_at ? new Date(o.updated_at) : o.created_at ? new Date(o.created_at) : undefined,
  isDeleted: o.is_deleted === true,
  payload: o,
});

export class SquareConnector implements Connector {
  readonly source = "square" as const;

  constructor(private readonly cfg: SquareConfig) {}

  private async api<T>(path: string, body?: unknown, method?: string) {
    const token = await requireSecret(this.cfg.secrets, SQUARE_TOKEN_SECRET, "Square");
    return requestJson<T>(`${this.cfg.baseUrl}${path}`, {
      method,
      body,
      headers: { Authorization: `Bearer ${token}`, "Square-Version": this.cfg.apiVersion },
      fetchImpl: this.cfg.fetchImpl,
    });
  }

  async sync(ctx: SyncContext) {
    await requireSecret(this.cfg.secrets, SQUARE_TOKEN_SECRET, "Square");
    await this.ensureWebhookSubscription(ctx);
    const locationIds = await this.syncLocations(ctx);
    await this.syncCatalog(ctx);
    if (ctx.outOfTime()) return;
    await this.syncOrders(ctx, locationIds);
    if (ctx.outOfTime()) return;
    for (const loc of locationIds) {
      if (ctx.outOfTime()) return;
      await this.syncUpdatedList(ctx, loc, "/v2/payments", "payments");
      if (ctx.outOfTime()) return;
      await this.syncUpdatedList(ctx, loc, "/v2/refunds", "refunds");
    }
  }

  private async syncLocations(ctx: SyncContext): Promise<string[]> {
    const res = await this.api<{ locations?: SquareObject[] }>("/v2/locations");
    const locations = res.locations ?? [];
    await ctx.emit(locations.map((l) => toRecord("locations", l)));
    return locations.map((l) => l.id);
  }

  private async syncCatalog(ctx: SyncContext) {
    const since = ctx.state.cursors.catalog;
    let cursor: string | undefined;
    let newest = since;
    do {
      const res = await this.api<{ objects?: SquareObject[]; related_objects?: SquareObject[]; cursor?: string; latest_time?: string }>(
        "/v2/catalog/search",
        {
          object_types: ["ITEM", "ITEM_VARIATION", "CATEGORY"],
          include_deleted_objects: true,
          ...(since ? { begin_time: minusMs(since, OVERLAP_MS) } : {}),
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        },
      );
      const objects = res.objects ?? [];
      await ctx.emit(objects.map((o) => toRecord("catalog_objects", o)));
      // latest_time is Square's own watermark for the next delta query.
      newest = maxIso(newest, res.latest_time);
      for (const o of objects) newest = maxIso(newest, o.updated_at);
      cursor = res.cursor;
    } while (cursor && !ctx.outOfTime());
    if (newest && !cursor) await ctx.saveCursor("catalog", newest);
  }

  private async syncOrders(ctx: SyncContext, locationIds: string[]) {
    // SearchOrders takes at most 10 locations per call; keep one cursor per batch.
    for (let i = 0; i < locationIds.length; i += MAX_LOCATIONS_PER_SEARCH) {
      const batch = locationIds.slice(i, i + MAX_LOCATIONS_PER_SEARCH);
      const cursorKey = i === 0 ? "orders" : `orders_${i / MAX_LOCATIONS_PER_SEARCH}`;
      const since = ctx.state.cursors[cursorKey] ?? EPOCH;
      let page: string | undefined;
      let newest: string | undefined;
      do {
        const res = await this.api<{ orders?: SquareObject[]; cursor?: string }>("/v2/orders/search", {
          location_ids: batch,
          limit: 500,
          ...(page ? { cursor: page } : {}),
          query: {
            filter: {
              date_time_filter: { updated_at: { start_at: minusMs(since, OVERLAP_MS) } },
              state_filter: { states: ["OPEN", "COMPLETED", "CANCELED"] },
            },
            sort: { sort_field: "UPDATED_AT", sort_order: "ASC" },
          },
        });
        const orders = res.orders ?? [];
        await ctx.emit(orders.map((o) => toRecord("orders", o)));
        for (const o of orders) newest = maxIso(newest, o.updated_at);
        page = res.cursor;
        // Results are sorted by updated_at, so progress is safe to save mid-way.
        if (newest) await ctx.saveCursor(cursorKey, newest);
        if (orders.length) ctx.log("square orders page", { count: orders.length, through: newest });
      } while (page && !ctx.outOfTime());
    }
  }

  /**
   * Payments and refunds, one location at a time (without location_id Square
   * only returns the main location). Tracked by updated_at because processing
   * fees and status changes land after creation.
   */
  private async syncUpdatedList(ctx: SyncContext, locationId: string, path: string, field: "payments" | "refunds") {
    const cursorKey = `${field}:${locationId}`;
    const since = ctx.state.cursors[cursorKey];
    const params: Record<string, string> = {
      location_id: locationId,
      sort_field: "UPDATED_AT",
      sort_order: "ASC",
      limit: "100",
      // begin_time filters on created_at and defaults to one year ago; open it up to all history.
      begin_time: EPOCH,
      updated_at_begin_time: since ? minusMs(since, OVERLAP_MS) : EPOCH,
    };
    let page: string | undefined;
    let newest = since;
    do {
      const qs = new URLSearchParams({ ...params, ...(page ? { cursor: page } : {}) });
      const res = await this.api<{ payments?: SquareObject[]; refunds?: SquareObject[]; cursor?: string }>(`${path}?${qs}`);
      const items = res[field] ?? [];
      await ctx.emit(items.map((o) => toRecord(field, o)));
      for (const o of items) newest = maxIso(newest, o.updated_at ?? o.created_at);
      page = res.cursor;
      if (newest) await ctx.saveCursor(cursorKey, newest);
    } while (page && !ctx.outOfTime());
  }

  /**
   * Keep a Square webhook subscription pointed at our endpoint, checked once a
   * day. Square only reveals a signing key when a subscription is created or
   * its key is rotated, so the key is saved to Secret Manager at that moment.
   * Failures here never block the data sync.
   */
  async ensureWebhookSubscription(ctx: SyncContext) {
    const url = this.cfg.webhookUrl;
    const last = ctx.state.cursors.webhooks_checked_at;
    if (!url || (last && Date.now() - Date.parse(last) < DAY_MS)) return;
    try {
      type Sub = { id: string; notification_url?: string; enabled?: boolean; event_types?: string[]; signature_key?: string };
      const list = await this.api<{ subscriptions?: Sub[] }>("/v2/webhooks/subscriptions");
      const existing = (list.subscriptions ?? []).find((s) => s.notification_url === url);
      let key: string | undefined;
      if (!existing) {
        const created = await this.api<{ subscription?: Sub }>("/v2/webhooks/subscriptions", {
          idempotency_key: randomUUID(),
          subscription: { name: "Business dashboard", event_types: SQUARE_WEBHOOK_EVENTS, notification_url: url, api_version: this.cfg.apiVersion },
        });
        key = created.subscription?.signature_key;
        ctx.log("created Square webhook subscription", { id: created.subscription?.id });
      } else {
        const missing = SQUARE_WEBHOOK_EVENTS.filter((e) => !existing.event_types?.includes(e));
        if (missing.length || existing.enabled === false) {
          await this.api(`/v2/webhooks/subscriptions/${existing.id}`, {
            subscription: { enabled: true, event_types: SQUARE_WEBHOOK_EVENTS },
          }, "PUT");
        }
        if (!(await this.cfg.secrets.get(SQUARE_SIGNATURE_SECRET))) {
          const rotated = await this.api<{ signature_key?: string }>(`/v2/webhooks/subscriptions/${existing.id}/signature-key`, {
            idempotency_key: randomUUID(),
          });
          key = rotated.signature_key;
        }
      }
      if (key) await this.cfg.secrets.add(SQUARE_SIGNATURE_SECRET, key);
      await ctx.saveCursor("webhooks_checked_at", new Date().toISOString());
    } catch (err) {
      ctx.log("could not verify Square webhook subscription; will retry next run", { error: String(err) });
    }
  }

  async handleWebhook(req: WebhookRequest): Promise<RawRecord[]> {
    const webhookUrl = this.cfg.webhookUrl;
    const webhookSignatureKey = await this.cfg.secrets.get(SQUARE_SIGNATURE_SECRET);
    if (!webhookSignatureKey || !webhookUrl) throw new WebhookAuthError("Square webhooks are not configured");
    const ok = verifySquareSignature({
      signatureKey: webhookSignatureKey,
      notificationUrl: webhookUrl,
      rawBody: req.rawBody,
      signature: req.headers["x-square-hmacsha256-signature"],
    });
    if (!ok) throw new WebhookAuthError();

    const event = JSON.parse(req.rawBody.toString("utf8")) as {
      type?: string;
      data?: { type?: string; id?: string; object?: Record<string, SquareObject | undefined> };
    };
    const kind = event.type?.split(".")[0];
    const id = event.data?.id;
    if (!id) return [];
    if (kind === "order") {
      // Order events only carry a summary; fetch the full order.
      const res = await this.api<{ orders?: SquareObject[] }>("/v2/orders/batch-retrieve", { order_ids: [id] });
      return (res.orders ?? []).map((o) => toRecord("orders", o));
    }
    if (kind === "payment" || kind === "refund") {
      const obj = event.data?.object?.[kind];
      if (obj?.id) return [toRecord(kind === "payment" ? "payments" : "refunds", obj)];
      const res = await this.api<Record<string, SquareObject | undefined>>(kind === "payment" ? `/v2/payments/${id}` : `/v2/refunds/${id}`);
      const fetched = res[kind];
      return fetched ? [toRecord(kind === "payment" ? "payments" : "refunds", fetched)] : [];
    }
    return [];
  }
}

export type { Money };
