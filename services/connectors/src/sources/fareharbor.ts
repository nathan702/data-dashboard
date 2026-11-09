import { createHash, timingSafeEqual } from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import { HttpError, requestJson } from "../core/http.js";
import { NotConfiguredError, requireSecret, type SecretStore } from "../core/secrets.js";
import { WebhookAuthError, type Connector, type RawRecord, type SyncContext, type WebhookRequest } from "../core/types.js";

/**
 * FareHarbor Public API (developerresources.fareharbor.com/public-portal.html).
 * Each FareHarbor company (one per business line: River School, Events,
 * Haunted Forest) has its own Client ID + Secret, created in that company's
 * dashboard (Settings → Users & Permissions → user → API Keys → Public API),
 * exchanged for a short-lived token per company.
 *
 * Every run reads bookings created since the last run. Bookings change after
 * they're made (cancellations, refunds) and the API can't list "changed
 * since", so bookings with recent or upcoming activity are re-read every 6
 * hours and all bookings once a week. Only rows that changed are written.
 *
 * Only allow-listed fields are stored: never the customer profile (name,
 * email, phone), custom field answers, voucher numbers, display ids or tags.
 * Money stays in cents; staging models convert to dollars.
 */

/** Comma-separated company shortnames (the part after fareharbor.com/ in the dashboard address). */
export const FAREHARBOR_COMPANIES_SECRET = "fareharbor-companies";
export const fareharborClientIdSecret = (shortname: string) => `fareharbor-${shortname}-client-id`;
export const fareharborClientSecretSecret = (shortname: string) => `fareharbor-${shortname}-client-secret`;
/** Shared secret in the webhook URL (?key=…); FareHarbor can't sign webhooks. */
export const FAREHARBOR_WEBHOOK_KEY_SECRET = "fareharbor-webhook-key";

/** Bump when sanitizing changes what's stored: every booking is rewritten on its next read. */
export const FAREHARBOR_PARSER_VERSION = "2";

export const FAREHARBOR_ENTITIES = ["companies", "items", "availabilities", "bookings"];

const DAY_MS = 86_400_000;
/** Bookings with activity within this many days back, or upcoming, are re-read every RESCAN_MS. */
const RECENT_DAYS = 35;
const RESCAN_MS = 6 * 60 * 60_000;
const FULL_RESCAN_MS = 7 * DAY_MS;
/** How far ahead time slots (capacity) are read. */
const AHEAD_DAYS = 400;
/** The availabilities endpoint takes at most 92 days per request. */
const AVAILABILITY_SPAN_DAYS = 90;
/** New bookings are re-read from a little before the last one seen. */
const OVERLAP_MS = 10 * 60_000;
const PAGE = 100;
const MIN_REQUEST_GAP_MS = 110;
const SHORTNAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface StoredHashes {
  /** record id → stored row hash, for one company's bookings and (prefixed "a:") availabilities. */
  load(company: string): Promise<Map<string, string>>;
}

export interface FareharborConfig {
  secrets: SecretStore;
  /** Public API bases, tried in order until one answers (the first that works is kept). */
  baseUrls: string[];
  /** Token endpoints, tried in order until one answers. */
  tokenUrls: string[];
  /** Bookings created before this date aren't read. */
  historyStart: string;
  stored: StoredHashes;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function fareharborConfigFromEnv(env: NodeJS.ProcessEnv, secrets: SecretStore): FareharborConfig {
  return {
    secrets,
    // The portal's API reference and its guide name different hosts; try both.
    baseUrls: env.FAREHARBOR_BASE_URL ? [env.FAREHARBOR_BASE_URL] : ["https://api.fareharbor.com/v1", "https://fareharbor.com/api/public/v1"],
    // The portal's guide and its API reference name different hosts; try both.
    tokenUrls: env.FAREHARBOR_TOKEN_URL
      ? [env.FAREHARBOR_TOKEN_URL]
      : ["https://fareharbor.com/api/authentication/v1/token/", "https://api.fareharbor.com/v1/authentication/token/"],
    historyStart: env.FAREHARBOR_HISTORY_START ?? "2019-01-01",
    stored: new BigQueryStoredHashes(new BigQuery({ projectId: env.GCP_PROJECT_ID })),
  };
}

// ---------- dates ----------

const easternDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** Any ISO datetime (Z, +00:00, or a colon-less -0400) → UTC ISO, or null. */
export function fhTime(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Eastern calendar date of a datetime (all the companies are in Eastern time). */
export function easternDate(v: unknown): string | null {
  const iso = fhTime(v);
  return iso ? easternDay.format(new Date(iso)) : null;
}

const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

// ---------- sanitizing (allow-list) ----------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const hash = (v: unknown) => createHash("sha256").update(`${FAREHARBOR_PARSER_VERSION}|${JSON.stringify(v)}`).digest("hex").slice(0, 16);

export interface FhBooking {
  uuid: string;
  company: string;
  /** active | cancelled | uncancelled | rebooked */
  status: string | null;
  /** paid | unpaid | overpaid | underpaid */
  paidStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Activity start (UTC). */
  activityAt: string | null;
  /** Eastern dates of the activity and of the booking. */
  activityDate: string | null;
  createdDate: string | null;
  itemPk: number | null;
  itemName: string | null;
  customerCount: number | null;
  /** e.g. "2 Adult, 2 Child" (customer types only). */
  customerBreakdown: string | null;
  currency: string | null;
  /** Cents; null when the key's user can't view amounts. */
  grossTotal: number | null;
  refundTotal: number | null;
  netTotal: number | null;
  amountPaid: number | null;
  rebookedFrom: string | null;
  rebookedTo: string | null;
  rowHash: string;
}

/** A booking from the list or detail endpoint → the fields we keep. */
export function sanitizeBooking(raw: unknown, company: string): FhBooking | null {
  const b = obj(raw);
  const uuid = str(b.uuid);
  if (!uuid) return null;
  const item = obj(b.item);
  const row: Omit<FhBooking, "rowHash"> = {
    uuid,
    company,
    status: str(b.status),
    paidStatus: str(b.paid_status),
    createdAt: fhTime(b.created_at),
    updatedAt: fhTime(b.updated_at),
    activityAt: fhTime(b.activity_date),
    activityDate: easternDate(b.activity_date),
    createdDate: easternDate(b.created_at),
    itemPk: num(item.pk),
    itemName: str(item.name),
    customerCount: num(b.customer_count),
    customerBreakdown: str(b.customer_breakdown),
    currency: str(b.currency),
    grossTotal: num(b.gross_total),
    refundTotal: num(b.refund_total),
    netTotal: num(b.net_total),
    amountPaid: num(b.amount_paid),
    rebookedFrom: str(b.rebooked_from_uuid),
    rebookedTo: str(b.rebooked_to_uuid),
  };
  // updatedAt also changes on edits we don't store (contact details…), so it isn't hashed.
  const { updatedAt: _notHashed, ...hashed } = row;
  return { ...row, rowHash: hash(hashed) };
}

export interface FhAvailability {
  id: number;
  company: string;
  itemPk: number | null;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  capacity: number | null;
  status: string | null;
  rowHash: string;
}

export function sanitizeAvailability(raw: unknown, company: string): FhAvailability | null {
  const a = obj(raw);
  const id = num(a.id);
  if (id === null) return null;
  const row = {
    id,
    company,
    itemPk: num(obj(a.item).pk) ?? num(a.item),
    startAt: fhTime(a.start_at_utc),
    endAt: fhTime(a.end_at_utc),
    startDate: easternDate(a.start_at_utc),
    capacity: num(a.capacity),
    status: str(a.status),
  };
  return { ...row, rowHash: hash(row) };
}

// ---------- connector ----------

interface Page<T> {
  data?: T[];
  meta?: { total_count?: number };
}

export class FareharborConnector implements Connector {
  readonly source = "fareharbor" as const;
  readonly rawEntities = FAREHARBOR_ENTITIES;
  private lastRequest = 0;
  private readonly tokens = new Map<string, string>();
  /** The API base that answered, once one has. */
  private base: string | null = null;

  constructor(private readonly cfg: FareharborConfig) {}

  private sleep(ms: number) {
    return (this.cfg.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }
  private now() {
    return this.cfg.now?.() ?? new Date();
  }
  private async pace() {
    const wait = this.lastRequest + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequest = Date.now();
  }

  /** Shortnames from the fareharbor-companies secret. */
  async companies(): Promise<string[]> {
    const raw = await requireSecret(this.cfg.secrets, FAREHARBOR_COMPANIES_SECRET, "FareHarbor");
    const list = raw
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const bad = list.filter((s) => !SHORTNAME.test(s));
    if (bad.length) throw new Error(`fareharbor-companies has names that aren't FareHarbor shortnames: ${bad.join(", ")}`);
    return [...new Set(list)];
  }

  /** Exchange the company's Client ID + Secret for a token (kept until a 401). */
  private async token(company: string, fresh = false): Promise<string> {
    const cached = this.tokens.get(company);
    if (cached && !fresh) return cached;
    const clientId = await this.cfg.secrets.get(fareharborClientIdSecret(company));
    const clientSecret = await this.cfg.secrets.get(fareharborClientSecretSecret(company));
    if (!clientId || !clientSecret) {
      throw new NotConfiguredError(
        `FareHarbor isn't connected for ${company} yet: add the "${fareharborClientIdSecret(company)}" and "${fareharborClientSecretSecret(company)}" secrets`,
      );
    }
    let last: unknown;
    for (const url of this.cfg.tokenUrls) {
      await this.pace();
      try {
        const res = await requestJson<{ token?: string }>(url, {
          body: { client_id: clientId, client_secret: clientSecret, organization: company },
          fetchImpl: this.cfg.fetchImpl,
          sleep: this.cfg.sleep,
          maxRetries: 3,
        });
        if (!res.token) throw new Error("the token response had no token");
        this.tokens.set(company, res.token);
        return res.token;
      } catch (err) {
        last = err;
        // Wrong credentials are wrong on every host; anything else may be the wrong host.
        if (err instanceof HttpError && (err.status === 400 || err.status === 401)) break;
      }
    }
    // Never include the response body: it could echo the secret.
    const detail = last instanceof HttpError ? `HTTP ${last.status}` : last instanceof Error ? last.message : "unknown error";
    throw new Error(`FareHarbor sign-in failed for ${company} (${detail}); check its Client ID and Secret`);
  }

  /**
   * GET a company-scoped path. Until one API base has answered, a 403/404 or
   * network failure moves on to the next base; a 401 gets a fresh token once.
   */
  async get<T>(company: string, path: string, params: Record<string, string | number> = {}): Promise<T> {
    const qs = new URLSearchParams({ company_shortname: company });
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const bases = this.base ? [this.base] : this.cfg.baseUrls;
    let last: unknown;
    for (const base of bases) {
      try {
        const res = await this.getFrom<T>(base, company, `${path}?${qs}`);
        this.base = base;
        return res;
      } catch (err) {
        last = err;
        const wrongHost = !(err instanceof HttpError) || err.status === 403 || err.status === 404;
        if (this.base || !wrongHost) throw err;
      }
    }
    throw last;
  }

  private async getFrom<T>(base: string, company: string, pathAndQuery: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(company, attempt > 0);
      await this.pace();
      try {
        return await requestJson<T>(`${base}${pathAndQuery}`, {
          headers: { Authorization: `Bearer ${token}` },
          fetchImpl: this.cfg.fetchImpl,
          sleep: this.cfg.sleep,
          maxRetries: this.base ? undefined : 2,
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 401 && attempt === 0) continue;
        throw err;
      }
    }
  }

  /**
   * Every page of a list endpoint from `start` (an offset), one page at a
   * time. `onPage` returns true to stop early. Returns whether the end was reached.
   */
  private async eachPage<T>(company: string, path: string, params: Record<string, string | number>, onPage: (rows: T[], nextOffset: number) => Promise<boolean | void>, start = 0) {
    for (let offset = start - (start % PAGE); ; offset += PAGE) {
      const page = await this.get<Page<T>>(company, path, { ...params, limit: PAGE, offset });
      const rows = page.data ?? [];
      const total = page.meta?.total_count;
      const done = rows.length < PAGE || (total !== undefined && offset + rows.length >= total);
      const stop = await onPage(rows, offset + PAGE);
      if (done) return true;
      if (stop) return false;
    }
  }

  async sync(ctx: SyncContext) {
    const companies = await this.companies();
    // Check every company's keys first, so a missing one shows as "not connected".
    for (const c of companies) await this.token(c);
    await ctx.emit(companies.map((c) => ({ entity: "companies", recordId: c, payload: { shortname: c } })));

    const failures: string[] = [];
    for (const company of companies) {
      if (ctx.outOfTime()) return;
      try {
        await this.syncCompany(ctx, company);
      } catch (err) {
        // One company's failure doesn't stop the others.
        failures.push(`${company}: ${err instanceof Error ? err.message : String(err)}`);
        ctx.log("fareharbor company failed", { company, error: String(err) });
      }
    }
    if (failures.length) throw new Error(`FareHarbor sync failed for ${failures.join("; ")}`);
  }

  private async syncCompany(ctx: SyncContext, company: string) {
    const now = this.now();
    const cursors = ctx.state.cursors;
    const stored = await this.cfg.stored.load(company);
    ctx.log("fareharbor company", { company, api: this.base ?? "not chosen yet" });
    const older = (key: string, ms: number) => !cursors[key] || now.getTime() - Date.parse(cursors[key]!) >= ms;
    const historyStart = `${this.cfg.historyStart}T00:00:00.000Z`;

    // Bookings carry their item's name, so the item list is optional.
    try {
      await this.eachPage<Json>(company, "/items/", {}, async (rows) => {
        await ctx.emit(
          rows.flatMap((i) =>
            num(i.pk) === null ? [] : [{ entity: "items", recordId: `${company}:${i.pk}`, payload: { company, pk: num(i.pk), name: str(i.name), shortName: str(i.short_name), type: str(i.type) } }],
          ),
        );
      });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 403)) throw err;
      ctx.log("fareharbor items not readable with this key; skipped", { company });
    }

    let written = 0;
    const write = async (rows: unknown[]) => {
      const records: RawRecord[] = [];
      for (const r of rows) {
        const b = sanitizeBooking(r, company);
        if (b && stored.get(b.uuid) !== b.rowHash) {
          records.push({ entity: "bookings", recordId: b.uuid, sourceUpdatedAt: b.updatedAt ? new Date(b.updatedAt) : undefined, payload: b });
          stored.set(b.uuid, b.rowHash);
        }
      }
      written += await ctx.emit(records);
    };

    /** Bookings created from `since` on, oldest first; `key` keeps the newest creation time reached. Returns whether it finished. */
    const walkCreated = async (since: string, key: string) => {
      let newest = since;
      return this.eachPage<Json>(company, "/bookings/", { created_after: new Date(Date.parse(since) - OVERLAP_MS).toISOString(), sort_by: "created_at", sort_order: "asc" }, async (rows) => {
        await write(rows);
        for (const r of rows) {
          const t = fhTime(r.created_at);
          if (t && t > newest) newest = t;
        }
        // Sorted by creation, so progress is safe to save page by page.
        await ctx.saveCursor(key, newest);
        return ctx.outOfTime();
      });
    };

    // 1. New bookings (everything since historyStart on the first run).
    const createdKey = `created:${company}`;
    const firstRun = !cursors[createdKey];
    if (await walkCreated(cursors[createdKey] || historyStart, createdKey)) {
      if (firstRun) await ctx.saveCursor(`full:${company}`, now.toISOString());
    }
    ctx.log("fareharbor new bookings", { company, written });
    if (ctx.outOfTime()) return;

    // 2. Recent and upcoming activity, every 6 hours: cancellations and refunds land here.
    const recentKey = `recent:${company}`;
    const recentPos = `recent_offset:${company}`;
    if (ctx.mode === "backfill" || older(recentKey, RESCAN_MS) || cursors[recentPos]) {
      const done = await this.eachPage<Json>(
        company,
        "/bookings/",
        { activity_after: addDays(now.toISOString(), -RECENT_DAYS), sort_by: "activity_date", sort_order: "asc" },
        async (rows, next) => {
          await write(rows);
          await ctx.saveCursor(recentPos, String(next));
          return ctx.outOfTime();
        },
        Number(cursors[recentPos] || 0),
      );
      if (done) {
        await ctx.saveCursor(recentPos, "");
        await ctx.saveCursor(recentKey, now.toISOString());
      }
      ctx.log("fareharbor recent bookings re-read", { company, written });
    }
    if (ctx.outOfTime()) return;

    // 3. Time slots and their capacity (recent and upcoming), every 6 hours.
    const slotsKey = `slots:${company}`;
    if (ctx.mode === "backfill" || older(slotsKey, RESCAN_MS)) {
      const from = addDays(now.toISOString(), -RECENT_DAYS);
      const to = addDays(now.toISOString(), AHEAD_DAYS);
      for (let start = from; start < to; start = addDays(start, AVAILABILITY_SPAN_DAYS)) {
        const end = addDays(start, AVAILABILITY_SPAN_DAYS) < to ? addDays(start, AVAILABILITY_SPAN_DAYS) : to;
        await this.eachPage<Json>(company, "/availabilities/", { start_after: start, start_before: end }, async (rows) => {
          const records: RawRecord[] = [];
          for (const r of rows) {
            const a = sanitizeAvailability(r, company);
            if (a && stored.get(`a:${company}:${a.id}`) !== a.rowHash) records.push({ entity: "availabilities", recordId: `${company}:${a.id}`, payload: a });
          }
          await ctx.emit(records);
        });
        if (ctx.outOfTime()) return;
      }
      await ctx.saveCursor(slotsKey, now.toISOString());
    }
    if (ctx.outOfTime()) return;

    // 4. All bookings again, weekly (late refunds on older bookings), resuming where a run stopped.
    const fullKey = `full:${company}`;
    const fullPos = `full_pos:${company}`;
    if (ctx.mode === "backfill" || older(fullKey, FULL_RESCAN_MS) || cursors[fullPos]) {
      if (await walkCreated(cursors[fullPos] || historyStart, fullPos)) {
        await ctx.saveCursor(fullPos, "");
        await ctx.saveCursor(fullKey, now.toISOString());
      }
      ctx.log("fareharbor all bookings re-read", { company, written });
    }
  }

  /**
   * FareHarbor posts the booking to a URL carrying our shared key. The key is
   * checked, then the booking is re-read from the API so a forged delivery
   * can't plant data.
   */
  async handleWebhook(req: WebhookRequest): Promise<RawRecord[]> {
    const expected = await this.cfg.secrets.get(FAREHARBOR_WEBHOOK_KEY_SECRET);
    if (!expected) throw new WebhookAuthError("FareHarbor webhooks are not configured");
    const given = Buffer.from(new URL(req.url).searchParams.get("key") ?? "");
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new WebhookAuthError();

    let body: Json;
    try {
      body = obj(JSON.parse(req.rawBody.toString("utf8")));
    } catch {
      return [];
    }
    const booking = obj(body.booking);
    const uuid = str(booking.uuid);
    const company = str(obj(booking.company).shortname)?.toLowerCase();
    // Only the companies we were set up for.
    if (!uuid || !company || !(await this.companies()).includes(company)) return [];
    const res = await this.get<{ data?: unknown }>(company, `/bookings/${encodeURIComponent(uuid)}`);
    const b = sanitizeBooking(res.data, company);
    return b ? [{ entity: "bookings", recordId: b.uuid, sourceUpdatedAt: b.updatedAt ? new Date(b.updatedAt) : undefined, payload: b }] : [];
  }
}

export class BigQueryStoredHashes implements StoredHashes {
  constructor(private readonly bq: BigQuery) {}
  async load(company: string) {
    const out = new Map<string, string>();
    for (const [table, prefix] of [
      ["bookings", ""],
      ["availabilities", "a:"],
    ] as const) {
      const [exists] = await this.bq.dataset("raw_fareharbor").table(table).exists();
      if (!exists) continue;
      const [rows] = await this.bq.query({
        query: `
          SELECT record_id AS id, JSON_VALUE(payload, '$.rowHash') AS row_hash
          FROM \`raw_fareharbor.${table}\`
          WHERE JSON_VALUE(payload, '$.company') = @company
          QUALIFY ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY source_updated_at DESC, ingested_at DESC) = 1`,
        params: { company },
      });
      for (const r of rows as Array<{ id: string; row_hash: string }>) out.set(prefix + r.id, r.row_hash);
    }
    return out;
  }
}
