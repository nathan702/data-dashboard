import { createHash } from "node:crypto";
import { HttpError, requestJson } from "../core/http.js";
import { requireSecret, type SecretStore } from "../core/secrets.js";
import type { Connector, RawRecord, SyncContext } from "../core/types.js";

/**
 * HubSpot deals (Education Programs, CHAPs group bookings), read with a
 * private app token: the deal pipelines and their stages, every deal's
 * allow-listed fields, the deal properties that can be reported on, and the
 * line items (products) on each deal. Each pipeline is assigned to a business
 * line on the Settings page.
 *
 * Deals and line items change after they're made, so every run reads the
 * ones modified since the last run (HubSpot's search, sorted by last
 * modified); deleted ones are checked once a day. Only rows that changed are
 * written.
 *
 * Never stored: deal names (they often name a school or a person), contacts,
 * companies, notes, emails, owners or any free-text property. Kept: ids,
 * pipeline, stage, amount, dates, and the account's own date, number,
 * dropdown and yes/no properties (fixed choices, e.g. program type).
 */

export const HUBSPOT_TOKEN_SECRET = "hubspot-private-app-token";

/** Bump when sanitizing changes what's stored: every deal is rewritten on its next read. */
export const HUBSPOT_PARSER_VERSION = "2";

export const HUBSPOT_ENTITIES = ["pipelines", "properties", "deals", "line_items"];

/** Standard deal properties kept (no names or free text). */
const STANDARD_PROPERTIES = [
  "pipeline",
  "dealstage",
  "amount",
  "deal_currency_code",
  "closedate",
  "createdate",
  "hs_lastmodifieddate",
  "hs_is_closed",
  "hs_is_closed_won",
];
const LINE_ITEM_PROPERTIES = ["name", "quantity", "price", "amount", "hs_sku", "hs_product_id", "discount", "hs_total_discount", "hs_lastmodifieddate"];
/** Custom property types kept: dates, numbers and fixed choices (never free text). */
const KEPT_TYPES = new Set(["date", "datetime", "number", "enumeration", "bool"]);
/** HubSpot's search returns at most 10,000 results per query; past that, start again from the last modified time. */
const SEARCH_CAP = 10_000;
const PAGE = 100;
/** Re-read a little before the cursor so updates landing mid-run aren't missed. */
const OVERLAP_MS = 5 * 60_000;
/** Search is limited to a few requests a second per account. */
const MIN_REQUEST_GAP_MS = 260;
const DAY_MS = 86_400_000;
/** First run: everything modified since this date (all of it, in practice). */
const EPOCH = "2000-01-01T00:00:00.000Z";

export interface HubspotConfig {
  secrets: SecretStore;
  baseUrl: string;
  /**
   * The deal property holding the program / event date (e.g. "start_datetime").
   * Revenue by service date uses it, else the close date.
   */
  serviceDateProperty?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function hubspotConfigFromEnv(env: NodeJS.ProcessEnv, secrets: SecretStore): HubspotConfig {
  return {
    secrets,
    baseUrl: env.HUBSPOT_BASE_URL ?? "https://api.hubapi.com",
    serviceDateProperty: env.HUBSPOT_SERVICE_DATE_PROPERTY?.trim() || undefined,
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** HubSpot dates come as ISO strings or epoch milliseconds; date-only properties as "YYYY-MM-DD". */
export function hsTime(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return `${s}T00:00:00.000Z`;
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const easternDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
/** Eastern calendar date of a timestamp; a date-only value keeps its date. */
export function hsDate(v: unknown): string | null {
  const s = str(v);
  if (s && /^\d{4}-\d\d-\d\d$/.test(s)) return s;
  const iso = hsTime(v);
  return iso ? easternDay.format(new Date(iso)) : null;
}

/** A deal property whose values are kept. */
export interface KeptProperty {
  name: string;
  label: string;
  type: "date" | "datetime" | "number" | "enumeration" | "bool";
  /** For dropdowns and yes/no: the internal value and its label. */
  options: Array<{ value: string; label: string }>;
}

export interface HsDeal {
  id: string;
  pipeline: string | null;
  stage: string | null;
  amount: number | null;
  currency: string | null;
  isClosed: boolean;
  isWon: boolean;
  createdAt: string | null;
  closedAt: string | null;
  /** Eastern dates. */
  createdDate: string | null;
  closeDate: string | null;
  /** The program / event date (the configured property), else null. */
  serviceDate: string | null;
  serviceDateProperty: string | null;
  /** Kept property values as text (numbers as digits, dates as YYYY-MM-DD, choices as their internal value). */
  props: Array<{ name: string; value: string }>;
  rowHash: string;
}

const hash = (v: unknown) => createHash("sha256").update(`${HUBSPOT_PARSER_VERSION}|${JSON.stringify(v)}`).digest("hex").slice(0, 16);

export function sanitizeDeal(raw: unknown, kept: KeptProperty[], serviceDateProperty?: string): HsDeal | null {
  const d = obj(raw);
  const id = str(d.id);
  if (!id) return null;
  const p = obj(d.properties);
  const props: HsDeal["props"] = [];
  for (const k of kept) {
    const v = k.type === "number" ? num(p[k.name]) : k.type === "date" || k.type === "datetime" ? hsDate(p[k.name]) : str(p[k.name]);
    if (v !== null) props.push({ name: k.name, value: String(v) });
  }
  const row = {
    id,
    pipeline: str(p.pipeline),
    stage: str(p.dealstage),
    amount: num(p.amount),
    currency: str(p.deal_currency_code),
    isClosed: p.hs_is_closed === "true" || p.hs_is_closed === true,
    isWon: p.hs_is_closed_won === "true" || p.hs_is_closed_won === true,
    createdAt: hsTime(p.createdate),
    closedAt: hsTime(p.closedate),
    createdDate: hsDate(p.createdate),
    closeDate: hsDate(p.closedate),
    serviceDate: serviceDateProperty ? hsDate(p[serviceDateProperty]) : null,
    serviceDateProperty: serviceDateProperty ?? null,
    props,
  };
  return { ...row, rowHash: hash(row) };
}

export interface HsLineItem {
  id: string;
  dealId: string | null;
  /** Product name as on the line item. */
  name: string | null;
  sku: string | null;
  productId: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  discount: number | null;
  rowHash: string;
}

export function sanitizeLineItem(raw: unknown, dealId: string | null): HsLineItem | null {
  const l = obj(raw);
  const id = str(l.id);
  if (!id) return null;
  const p = obj(l.properties);
  const row = {
    id,
    dealId,
    name: str(p.name),
    sku: str(p.hs_sku),
    productId: str(p.hs_product_id),
    quantity: num(p.quantity),
    price: num(p.price),
    amount: num(p.amount),
    discount: num(p.hs_total_discount) ?? num(p.discount),
  };
  return { ...row, rowHash: hash(row) };
}

type SearchPage = { results?: Json[]; paging?: { next?: { after?: string } } };

export class HubspotConnector implements Connector {
  readonly source = "hubspot" as const;
  readonly rawEntities = HUBSPOT_ENTITIES;
  private lastRequest = 0;

  constructor(private readonly cfg: HubspotConfig) {}

  private sleep(ms: number) {
    return (this.cfg.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }
  private now() {
    return this.cfg.now?.() ?? new Date();
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const token = await requireSecret(this.cfg.secrets, HUBSPOT_TOKEN_SECRET, "HubSpot");
    const wait = this.lastRequest + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequest = Date.now();
    return requestJson<T>(`${this.cfg.baseUrl}${path}`, { body, headers: { Authorization: `Bearer ${token}` }, fetchImpl: this.cfg.fetchImpl, sleep: this.cfg.sleep });
  }

  async sync(ctx: SyncContext) {
    await requireSecret(this.cfg.secrets, HUBSPOT_TOKEN_SECRET, "HubSpot");
    await this.syncPipelines(ctx);
    const kept = await this.keptProperties(ctx);
    const configHash = createHash("sha256").update(JSON.stringify([HUBSPOT_PARSER_VERSION, kept.map((k) => k.name), this.cfg.serviceDateProperty ?? ""])).digest("hex").slice(0, 12);
    // A new parser, new properties or another program-date property: read every deal again.
    if (ctx.mode === "backfill" || ctx.state.cursors.deals_config !== configHash) {
      await ctx.saveCursor("deals_modified", "");
      await ctx.saveCursor("deals_config", configHash);
      ctx.state.cursors.deals_modified = "";
    }
    if (ctx.mode === "backfill") {
      await ctx.saveCursor("line_items_modified", "");
      ctx.state.cursors.line_items_modified = "";
    }
    const properties = [...new Set([...STANDARD_PROPERTIES, ...kept.map((k) => k.name), ...(this.cfg.serviceDateProperty ? [this.cfg.serviceDateProperty] : [])])];
    const deals = await this.walkModified(ctx, "deals", "deals_modified", properties, async (rows) =>
      rows.flatMap((raw) => {
        const d = sanitizeDeal(raw, kept, this.cfg.serviceDateProperty);
        return d ? [{ entity: "deals", recordId: d.id, sourceUpdatedAt: modifiedAt(raw), payload: d }] : [];
      }),
    );
    ctx.log("hubspot deals", deals);
    if (ctx.outOfTime()) return;
    await this.syncLineItems(ctx);
    if (ctx.outOfTime()) return;
    const last = ctx.state.cursors.archived_checked;
    if (!last || this.now().getTime() - Date.parse(last) >= DAY_MS) {
      await this.syncArchived(ctx, "deals");
      await this.syncArchived(ctx, "line_items");
      await ctx.saveCursor("archived_checked", this.now().toISOString());
    }
  }

  /** Pipelines and their stages (labels and whether a stage is closed). */
  private async syncPipelines(ctx: SyncContext) {
    const res = await this.api<{ results?: Json[] }>("/crm/v3/pipelines/deals");
    const records: RawRecord[] = (res.results ?? []).flatMap((p) => {
      const id = str(p.id);
      if (!id) return [];
      const stages = (Array.isArray(p.stages) ? p.stages : []).map((s) => {
        const o = obj(s);
        const meta = obj(o.metadata);
        return { id: str(o.id), label: str(o.label), order: num(o.displayOrder), isClosed: meta.isClosed === "true" || meta.isClosed === true, probability: num(meta.probability) };
      });
      return [{ entity: "pipelines", recordId: id, payload: { id, label: str(p.label), archived: p.archived === true, stages } }];
    });
    await ctx.emit(records);
    ctx.log("hubspot pipelines", { count: records.length });
  }

  /**
   * The account's own deal properties that hold dates, numbers or fixed
   * choices (never free text), plus the program-date property. Their labels and
   * choices are stored too, for the Settings page.
   */
  private async keptProperties(ctx: SyncContext): Promise<KeptProperty[]> {
    const res = await this.api<{ results?: Json[] }>("/crm/v3/properties/deals");
    const out: KeptProperty[] = [];
    let serviceFound = !this.cfg.serviceDateProperty;
    for (const p of res.results ?? []) {
      const name = str(p.name);
      const type = str(p.type);
      if (!name || !type) continue;
      if (name === this.cfg.serviceDateProperty) {
        serviceFound = true;
        if (type !== "date" && type !== "datetime") throw new Error(`HubSpot property "${name}" (HUBSPOT_SERVICE_DATE_PROPERTY) isn't a date`);
      }
      const own = p.hubspotDefined !== true && p.calculated !== true;
      if (!(own && KEPT_TYPES.has(type)) && name !== this.cfg.serviceDateProperty) continue;
      const options = (Array.isArray(p.options) ? p.options : []).flatMap((o) => {
        const x = obj(o);
        const value = str(x.value);
        return value === null || x.hidden === true ? [] : [{ value, label: str(x.label) ?? value }];
      });
      out.push({ name, label: str(p.label) ?? name, type: type as KeptProperty["type"], options });
    }
    if (!serviceFound) throw new Error(`HubSpot has no deal property named "${this.cfg.serviceDateProperty}" (HUBSPOT_SERVICE_DATE_PROPERTY)`);
    out.sort((a, b) => a.name.localeCompare(b.name));
    await ctx.emit(out.map((k) => ({ entity: "properties", recordId: k.name, payload: { ...k, rowHash: hash(k) } })));
    return out;
  }

  /**
   * Objects modified since the cursor, oldest first; past HubSpot's 10,000-result
   * limit, search again from the last one seen. `toRecords` turns each page into rows.
   */
  private async walkModified(ctx: SyncContext, object: string, cursorKey: string, properties: string[], toRecords: (rows: Json[]) => Promise<RawRecord[]>) {
    let since = ctx.state.cursors[cursorKey] || EPOCH;
    let written = 0;
    let read = 0;
    for (;;) {
      let after: string | undefined;
      let newest = since;
      let reached = 0;
      do {
        const res = await this.api<SearchPage>(`/crm/v3/objects/${object}/search`, {
          filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(Date.parse(since) - OVERLAP_MS) }] }],
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
          properties,
          limit: PAGE,
          ...(after ? { after } : {}),
        });
        const rows = res.results ?? [];
        read += rows.length;
        written += await ctx.emit(await toRecords(rows));
        for (const raw of rows) {
          const m = hsTime(obj(obj(raw).properties).hs_lastmodifieddate);
          if (m && m > newest) newest = m;
        }
        // Sorted by last modified, so progress is safe to save page by page.
        if (newest !== since) await ctx.saveCursor(cursorKey, newest);
        after = res.paging?.next?.after;
        reached += rows.length;
        if (ctx.outOfTime()) return { read, written };
      } while (after && reached + PAGE <= SEARCH_CAP);
      if (!after) break;
      if (newest === since) throw new Error(`HubSpot returned more than 10,000 ${object} modified at the same moment; can't page past them`);
      since = newest;
    }
    return { read, written };
  }

  /** Line items modified since the last run, each with the deal it belongs to. A token without the line-items scope skips them. */
  private async syncLineItems(ctx: SyncContext) {
    try {
      const res = await this.walkModified(ctx, "line_items", "line_items_modified", LINE_ITEM_PROPERTIES, async (rows) => {
        const deals = await this.lineItemDeals(rows.flatMap((r) => (str(r.id) ? [str(r.id)!] : [])));
        return rows.flatMap((raw) => {
          const l = sanitizeLineItem(raw, deals.get(str(raw.id) ?? "") ?? null);
          return l ? [{ entity: "line_items", recordId: l.id, sourceUpdatedAt: modifiedAt(raw), payload: l }] : [];
        });
      });
      ctx.log("hubspot line items", res);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        ctx.log("hubspot line items skipped: the token needs the crm.objects.line_items.read scope");
        return;
      }
      throw err;
    }
  }

  /** Line item id → deal id. */
  private async lineItemDeals(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const res = await this.api<{ results?: Json[] }>("/crm/v4/associations/line_items/deals/batch/read", { inputs: ids.map((id) => ({ id })) });
    for (const r of res.results ?? []) {
      const from = str(obj(r.from).id);
      const to = (Array.isArray(r.to) ? r.to : []).map((t) => obj(t).toObjectId).find((v) => v !== undefined && v !== null);
      if (from && to !== undefined) out.set(from, String(to));
    }
    return out;
  }

  /** Objects deleted in HubSpot: marked deleted here, once a day. */
  private async syncArchived(ctx: SyncContext, object: "deals" | "line_items") {
    let after: string | undefined;
    let removed = 0;
    do {
      const qs = new URLSearchParams({ archived: "true", limit: String(PAGE), ...(after ? { after } : {}) });
      let res: SearchPage;
      try {
        res = await this.api(`/crm/v3/objects/${object}?${qs}`);
      } catch (err) {
        // Not worth failing the sync over; tomorrow's run tries again.
        if (err instanceof HttpError) {
          ctx.log(`hubspot deleted ${object} not checked`, { status: err.status });
          return;
        }
        throw err;
      }
      const records: RawRecord[] = (res.results ?? []).flatMap((d) => (str(d.id) ? [{ entity: object, recordId: str(d.id)!, isDeleted: true, payload: { id: str(d.id) } }] : []));
      removed += await ctx.emit(records);
      after = res.paging?.next?.after;
      if (ctx.outOfTime()) return;
    } while (after);
    ctx.log(`hubspot deleted ${object}`, { removed });
  }
}

function modifiedAt(raw: Json): Date | undefined {
  const m = hsTime(obj(raw.properties).hs_lastmodifieddate);
  return m ? new Date(m) : undefined;
}
