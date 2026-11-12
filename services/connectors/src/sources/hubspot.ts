import { createHash } from "node:crypto";
import { HttpError, requestJson } from "../core/http.js";
import { requireSecret, type SecretStore } from "../core/secrets.js";
import type { Connector, RawRecord, SyncContext } from "../core/types.js";

/**
 * HubSpot deals (Education Programs, CHAPs group bookings), read with a
 * private app token: the deal pipelines and their stages, and every deal's
 * allow-listed fields. Each pipeline is assigned to a business line on the
 * Settings page.
 *
 * Deals change after they're made (stage, amount, dates), so every run reads
 * the ones modified since the last run (HubSpot's search, sorted by last
 * modified); deleted deals are checked once a day. Only rows that changed are
 * written.
 *
 * Never stored: deal names (they often name a school or a person), contacts,
 * companies, notes, emails or owners. Kept: ids, pipeline, stage, amount,
 * dates, and the number properties and dates of the account's own custom
 * properties (e.g. a program date or a student count).
 */

export const HUBSPOT_TOKEN_SECRET = "hubspot-private-app-token";

/** Bump when sanitizing changes what's stored: every deal is rewritten on its next read. */
export const HUBSPOT_PARSER_VERSION = "1";

export const HUBSPOT_ENTITIES = ["pipelines", "deals"];

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
/** HubSpot's search returns at most 10,000 results per query; past that, start again from the last modified time. */
const SEARCH_CAP = 10_000;
const PAGE = 100;
/** Re-read a little before the cursor so updates landing mid-run aren't missed. */
const OVERLAP_MS = 5 * 60_000;
/** Search is limited to a few requests a second per account. */
const MIN_REQUEST_GAP_MS = 260;
const DAY_MS = 86_400_000;
/** First run: deals modified since this date (all of them, in practice). */
const EPOCH = "2000-01-01T00:00:00.000Z";

export interface HubspotConfig {
  secrets: SecretStore;
  baseUrl: string;
  /**
   * The custom deal property holding the program / event date, if any
   * (e.g. "program_date"). Revenue by service date uses it, else the close date.
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

/** Custom deal properties whose values are kept: dates and numbers only (never text). */
export interface KeptProperty {
  name: string;
  label: string;
  type: "date" | "datetime" | "number";
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
  /** Custom date and number properties, by name. */
  custom: Record<string, string | number | null>;
  rowHash: string;
}

export function sanitizeDeal(raw: unknown, kept: KeptProperty[], serviceDateProperty?: string): HsDeal | null {
  const d = obj(raw);
  const id = str(d.id);
  if (!id) return null;
  const p = obj(d.properties);
  const custom: Record<string, string | number | null> = {};
  for (const k of kept) custom[k.name] = k.type === "number" ? num(p[k.name]) : hsDate(p[k.name]);
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
    custom,
  };
  return { ...row, rowHash: createHash("sha256").update(`${HUBSPOT_PARSER_VERSION}|${JSON.stringify(row)}`).digest("hex").slice(0, 16) };
}

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
    const kept = await this.keptProperties();
    const configHash = createHash("sha256").update(JSON.stringify([HUBSPOT_PARSER_VERSION, kept.map((k) => k.name), this.cfg.serviceDateProperty ?? ""])).digest("hex").slice(0, 12);
    // A new parser, new custom properties or another program-date property: read every deal again.
    if (ctx.mode === "backfill" || ctx.state.cursors.deals_config !== configHash) {
      await ctx.saveCursor("deals_modified", "");
      await ctx.saveCursor("deals_config", configHash);
      ctx.state.cursors.deals_modified = "";
    }
    await this.syncDeals(ctx, kept);
    if (ctx.outOfTime()) return;
    const last = ctx.state.cursors.deals_archived_checked;
    if (!last || this.now().getTime() - Date.parse(last) >= DAY_MS) await this.syncArchived(ctx);
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

  /** The account's own (not HubSpot-defined) deal properties that hold dates or numbers. */
  private async keptProperties(): Promise<KeptProperty[]> {
    const res = await this.api<{ results?: Json[] }>("/crm/v3/properties/deals");
    const out: KeptProperty[] = [];
    for (const p of res.results ?? []) {
      const name = str(p.name);
      const type = str(p.type);
      if (!name || p.hubspotDefined === true || p.calculated === true) continue;
      if (type === "date" || type === "datetime" || type === "number") out.push({ name, label: str(p.label) ?? name, type });
    }
    if (this.cfg.serviceDateProperty && !out.some((k) => k.name === this.cfg.serviceDateProperty)) {
      throw new Error(`HubSpot has no custom date property named "${this.cfg.serviceDateProperty}" (HUBSPOT_SERVICE_DATE_PROPERTY)`);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Deals modified since the cursor, oldest first; past HubSpot's 10,000-result limit, search again from the last one seen. */
  private async syncDeals(ctx: SyncContext, kept: KeptProperty[]) {
    const properties = [...STANDARD_PROPERTIES, ...kept.map((k) => k.name)];
    let since = ctx.state.cursors.deals_modified || EPOCH;
    let written = 0;
    let read = 0;
    for (;;) {
      let after: string | undefined;
      let newest = since;
      let reached = 0;
      do {
        const res = await this.api<{ results?: Json[]; paging?: { next?: { after?: string } } }>("/crm/v3/objects/deals/search", {
          filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(Date.parse(since) - OVERLAP_MS) }] }],
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
          properties,
          limit: PAGE,
          ...(after ? { after } : {}),
        });
        const deals = res.results ?? [];
        read += deals.length;
        const records: RawRecord[] = [];
        for (const raw of deals) {
          const d = sanitizeDeal(raw, kept, this.cfg.serviceDateProperty);
          if (!d) continue;
          const modified = hsTime(obj(obj(raw).properties).hs_lastmodifieddate);
          records.push({ entity: "deals", recordId: d.id, sourceUpdatedAt: modified ? new Date(modified) : undefined, payload: d });
          if (modified && modified > newest) newest = modified;
        }
        written += await ctx.emit(records);
        // Sorted by last modified, so progress is safe to save page by page.
        if (newest !== since) await ctx.saveCursor("deals_modified", newest);
        after = res.paging?.next?.after;
        reached += deals.length;
        if (ctx.outOfTime()) return;
      } while (after && reached + PAGE <= SEARCH_CAP);
      if (!after) break;
      // Hit the cap: start a new search from the newest modified time seen.
      if (newest === since) throw new Error("HubSpot returned more than 10,000 deals modified at the same moment; can't page past them");
      since = newest;
    }
    ctx.log("hubspot deals", { read, written });
  }

  /** Deals deleted in HubSpot: marked deleted here, once a day. */
  private async syncArchived(ctx: SyncContext) {
    let after: string | undefined;
    let removed = 0;
    do {
      const qs = new URLSearchParams({ archived: "true", limit: String(PAGE), ...(after ? { after } : {}) });
      let res: { results?: Json[]; paging?: { next?: { after?: string } } };
      try {
        res = await this.api(`/crm/v3/objects/deals?${qs}`);
      } catch (err) {
        // Not worth failing the sync over; tomorrow's run tries again.
        if (err instanceof HttpError) {
          ctx.log("hubspot deleted deals not checked", { status: err.status });
          return;
        }
        throw err;
      }
      const records: RawRecord[] = (res.results ?? []).flatMap((d) => (str(d.id) ? [{ entity: "deals", recordId: str(d.id)!, isDeleted: true, payload: { id: str(d.id) } }] : []));
      removed += await ctx.emit(records);
      after = res.paging?.next?.after;
      if (ctx.outOfTime()) return;
    } while (after);
    await ctx.saveCursor("deals_archived_checked", this.now().toISOString());
    ctx.log("hubspot deleted deals", { removed });
  }
}
