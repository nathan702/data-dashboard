import { createHash, timingSafeEqual } from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import { HttpError, requestJson } from "../core/http.js";
import { requireSecret, type SecretStore } from "../core/secrets.js";
import { WebhookAuthError, type Connector, type RawRecord, type SyncContext, type WebhookRequest } from "../core/types.js";

/**
 * FareHarbor External API v1: each company (one per business line: River
 * School, Events, Haunted Forest) → its items → availabilities by date →
 * the bookings on each availability → each booking's details with payments.
 * The API has no "changed since" listing, so recent and upcoming dates are
 * re-read every few hours and older dates once; webhooks (when set up) bring
 * changes in between.
 *
 * Only allow-listed fields are stored: never the contact's name, phone or
 * email, notes, custom field answers (which often hold names or medical
 * details), voucher numbers or links. Money stays in FareHarbor's integer
 * cents; staging models convert to dollars.
 */

export const FAREHARBOR_APP_KEY_SECRET = "fareharbor-app-key";
export const FAREHARBOR_USER_KEY_SECRET = "fareharbor-user-key";
/** Shared secret in the webhook URL (?key=…); FareHarbor can't sign webhooks. */
export const FAREHARBOR_WEBHOOK_KEY_SECRET = "fareharbor-webhook-key";

/** Bump when sanitizing changes what's stored: every booking is rewritten on its next read. */
export const FAREHARBOR_PARSER_VERSION = "1";

export const FAREHARBOR_ENTITIES = ["companies", "items", "availabilities", "bookings"];

const DAY_MS = 86_400_000;
/** Dates older than this are read once (history); newer ones are re-read every RESCAN_MS. */
const SETTLED_DAYS = 35;
/** How far ahead upcoming bookings are read. */
const AHEAD_DAYS = 400;
const RESCAN_MS = 6 * 60 * 60_000;
/** 3,000 requests per 5 minutes and 30 per second are FareHarbor's limits; stay under both. */
const MIN_REQUEST_GAP_MS = 110;

export interface StoredHashes {
  /** record id → stored row hash, for bookings and availabilities of one company starting in [from, to]. */
  load(company: string, from: string, to: string): Promise<Map<string, string>>;
}

export interface FareharborConfig {
  secrets: SecretStore;
  baseUrl: string;
  /** First date read on the first run (all history after it). */
  historyStart: string;
  stored: StoredHashes;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function fareharborConfigFromEnv(env: NodeJS.ProcessEnv, secrets: SecretStore): FareharborConfig {
  return {
    secrets,
    baseUrl: env.FAREHARBOR_BASE_URL ?? "https://fareharbor.com/api/external/v1",
    historyStart: env.FAREHARBOR_HISTORY_START ?? "2019-01-01",
    stored: new BigQueryStoredHashes(new BigQuery({ projectId: env.GCP_PROJECT_ID })),
  };
}

// ---------- dates ----------

export const addDaysIso = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const endOfMonth = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

/** [from, to] (inclusive) split into calendar-month pieces; each piece spans at least two days (the API needs end > start). */
export function monthChunks(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = from;
  while (start <= to) {
    let end = endOfMonth(start) < to ? endOfMonth(start) : to;
    if (end === start) end = addDaysIso(start, 1);
    out.push([start, end]);
    start = addDaysIso(end, 1);
  }
  return out;
}

/** FareHarbor writes offsets without a colon ("2015-01-22T11:30:00-1000"); → UTC ISO, or null. */
export function fhTime(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The local calendar date of a FareHarbor datetime (the company's own time zone). */
export const fhLocalDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\d/.test(v) ? v.slice(0, 10) : null);

// ---------- sanitizing (allow-list) ----------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export interface FhBooking {
  uuid: string;
  pk: number | null;
  /** booked | cancelled | rebooked */
  status: string | null;
  rebookedFrom: string | null;
  rebookedTo: string | null;
  company: string;
  availabilityPk: number | null;
  itemPk: number | null;
  itemName: string | null;
  startAt: string | null;
  endAt: string | null;
  /** Local date the activity takes place. */
  startDate: string | null;
  customerCount: number | null;
  /** One entry per guest: customer type ("Adult", "Child"…), price in cents, check-in. */
  customers: Array<{ type: string | null; total: number | null; tax: number | null; checkin: string | null }>;
  /** Cents. */
  receiptSubtotal: number | null;
  receiptTaxes: number | null;
  receiptTotal: number | null;
  amountPaid: number | null;
  /** direct | desk | agent | affiliate (no names). */
  channel: string;
  payments: Array<{
    pk: number | null;
    createdAt: string | null;
    type: string | null;
    status: string | null;
    amountPaid: number | null;
    refunds: Array<{ pk: number | null; createdAt: string | null; amount: number | null; isCancelled: boolean }>;
  }>;
  /** True when only the availability's booking list was read (no prices). */
  partial: boolean;
  rowHash: string;
}

const hash = (v: unknown) => createHash("sha256").update(`${FAREHARBOR_PARSER_VERSION}|${JSON.stringify(v)}`).digest("hex").slice(0, 16);

export function sanitizeBooking(raw: unknown, company: string, availability?: { pk: number; startAt?: string | null; endAt?: string | null; itemPk?: number | null; itemName?: string | null }, partial = false): FhBooking | null {
  const b = obj(raw);
  const uuid = str(b.uuid);
  if (!uuid) return null;
  const av = obj(b.availability);
  const item = obj(av.item);
  const startRaw = str(av.start_at) ?? availability?.startAt ?? null;
  const row: Omit<FhBooking, "rowHash"> = {
    uuid,
    pk: num(b.pk),
    status: str(b.status),
    rebookedFrom: str(b.rebooked_from),
    rebookedTo: str(b.rebooked_to),
    company: str(obj(b.company).shortname) ?? company,
    availabilityPk: num(av.pk) ?? availability?.pk ?? null,
    itemPk: num(item.pk) ?? availability?.itemPk ?? null,
    itemName: str(item.name) ?? availability?.itemName ?? null,
    startAt: fhTime(startRaw),
    endAt: fhTime(str(av.end_at) ?? availability?.endAt),
    startDate: fhLocalDate(startRaw),
    customerCount: num(b.customer_count),
    customers: arr(b.customers).map((c) => {
      const cost = obj(obj(c).total_cost);
      return {
        type: str(obj(obj(obj(c).customer_type_rate).customer_type).singular),
        total: num(cost.total),
        tax: num(cost.tax),
        checkin: str(obj(obj(c).checkin_status).type),
      };
    }),
    receiptSubtotal: num(b.receipt_subtotal),
    receiptTaxes: num(b.receipt_taxes),
    receiptTotal: num(b.receipt_total),
    amountPaid: num(b.amount_paid),
    channel: b.agent ? "agent" : b.desk ? "desk" : b.affiliate_company ? "affiliate" : "direct",
    payments: arr(b.payments).map((p) => {
      const o = obj(p);
      return {
        pk: num(o.pk),
        createdAt: fhTime(o.created_at),
        type: str(o.type),
        status: str(o.status),
        amountPaid: num(o.amount_paid),
        refunds: arr(o.refunds).map((r) => {
          const x = obj(r);
          return { pk: num(x.pk), createdAt: fhTime(x.created_at), amount: num(x.amount_refunded), isCancelled: x.is_cancelled === true };
        }),
      };
    }),
    partial,
  };
  return { ...row, rowHash: hash(row) };
}

export interface FhAvailability {
  pk: number;
  company: string;
  itemPk: number;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  capacity: number | null;
  onlineBookingStatus: string | null;
  rowHash: string;
}

export function sanitizeAvailability(raw: unknown, company: string, itemPk: number): FhAvailability | null {
  const a = obj(raw);
  const pk = num(a.pk);
  if (pk === null) return null;
  const row = {
    pk,
    company,
    itemPk,
    startAt: fhTime(a.start_at),
    endAt: fhTime(a.end_at),
    startDate: fhLocalDate(a.start_at),
    capacity: num(a.capacity),
    onlineBookingStatus: str(a.online_booking_status),
  };
  return { ...row, rowHash: hash(row) };
}

// ---------- connector ----------

interface Company {
  shortname: string;
  name: string | null;
  currency: string | null;
}
interface Item {
  pk: number;
  name: string | null;
}

export class FareharborConnector implements Connector {
  readonly source = "fareharbor" as const;
  readonly rawEntities = FAREHARBOR_ENTITIES;
  private lastRequest = 0;

  constructor(private readonly cfg: FareharborConfig) {}

  private sleep(ms: number) {
    return (this.cfg.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }
  private now() {
    return this.cfg.now?.() ?? new Date();
  }

  private async headers() {
    return {
      "X-FareHarbor-API-App": await requireSecret(this.cfg.secrets, FAREHARBOR_APP_KEY_SECRET, "FareHarbor"),
      "X-FareHarbor-API-User": await requireSecret(this.cfg.secrets, FAREHARBOR_USER_KEY_SECRET, "FareHarbor"),
    };
  }

  /** GET with spacing between requests; a rate-limit 403 waits a minute and tries again. */
  async api<T>(path: string): Promise<T> {
    const headers = await this.headers();
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequest + MIN_REQUEST_GAP_MS - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequest = Date.now();
      try {
        return await requestJson<T>(`${this.cfg.baseUrl}${path}`, { headers, fetchImpl: this.cfg.fetchImpl, sleep: this.cfg.sleep });
      } catch (err) {
        const limited = err instanceof HttpError && err.status === 403 && /rate|limit|throttl|too many/i.test(err.body);
        if (!limited || attempt >= 3) throw err;
        await this.sleep(60_000);
      }
    }
  }

  async sync(ctx: SyncContext) {
    await this.headers();
    const { companies } = await this.api<{ companies?: Json[] }>("/companies/");
    const list: Company[] = (companies ?? [])
      .map((c) => ({ shortname: str(c.shortname) ?? "", name: str(c.name), currency: str(c.currency) }))
      .filter((c) => c.shortname);
    await ctx.emit(list.map((c) => ({ entity: "companies", recordId: c.shortname, payload: c })));
    ctx.log("fareharbor companies", { count: list.length });

    const today = this.now().toISOString().slice(0, 10);
    const settled = addDaysIso(today, -SETTLED_DAYS);
    const failures: string[] = [];
    for (const company of list) {
      if (ctx.outOfTime()) return;
      try {
        await this.syncCompany(ctx, company, today, settled);
      } catch (err) {
        // One company's failure (e.g. no access) doesn't stop the others.
        failures.push(`${company.shortname}: ${err instanceof Error ? err.message : String(err)}`);
        ctx.log("fareharbor company failed", { company: company.shortname, error: String(err) });
      }
    }
    if (failures.length) throw new Error(`FareHarbor sync failed for ${failures.join("; ")}`);
  }

  private async syncCompany(ctx: SyncContext, company: Company, today: string, settled: string) {
    const sn = company.shortname;
    const { items } = await this.api<{ items?: Json[] }>(`/companies/${encodeURIComponent(sn)}/items/`);
    const itemList: Item[] = (items ?? []).flatMap((i) => (num(i.pk) === null ? [] : [{ pk: num(i.pk)!, name: str(i.name) }]));
    await ctx.emit(itemList.map((i) => ({ entity: "items", recordId: `${sn}:${i.pk}`, payload: { company: sn, pk: i.pk, name: i.name } })));

    // History: dates before `settled`, read once, a month at a time.
    const historyKey = `history:${sn}`;
    // A backfill re-reads all history; scheduled runs then carry on from wherever it stopped.
    let history = ctx.mode === "backfill" ? this.cfg.historyStart : ctx.state.cursors[historyKey] || this.cfg.historyStart;

    // Recent and upcoming dates first (they matter most and change), every RESCAN_MS.
    const windowKey = `window:${sn}`;
    const posKey = `window_pos:${sn}`;
    const lastWindow = ctx.state.cursors[windowKey];
    if (!lastWindow || this.now().getTime() - Date.parse(lastWindow) >= RESCAN_MS || ctx.state.cursors[posKey]) {
      const windowStart = history < settled ? settled : history;
      let pos = ctx.state.cursors[posKey] || windowStart;
      if (pos < windowStart) pos = windowStart;
      for (const [from, to] of monthChunks(pos, addDaysIso(today, AHEAD_DAYS))) {
        if (ctx.outOfTime()) return;
        await this.syncRange(ctx, sn, itemList, from, to);
        await ctx.saveCursor(posKey, addDaysIso(to, 1));
      }
      await ctx.saveCursor(posKey, "");
      await ctx.saveCursor(windowKey, this.now().toISOString());
    }

    // A week's worth of settled dates at least, so each history read spans several days.
    while (addDaysIso(history, 7) <= settled && !ctx.outOfTime()) {
      const [from, to] = monthChunks(history, addDaysIso(settled, -1))[0]!;
      await this.syncRange(ctx, sn, itemList, from, to);
      history = addDaysIso(to, 1);
      await ctx.saveCursor(historyKey, history);
      ctx.log("fareharbor history", { company: sn, through: to });
    }
  }

  /** Every item's availabilities in [from, to] and their bookings; only changed rows are written. */
  private async syncRange(ctx: SyncContext, sn: string, items: Item[], from: string, to: string) {
    const stored = await this.cfg.stored.load(sn, from, to);
    let written = 0;
    let seen = 0;
    for (const item of items) {
      const { availabilities } = await this.api<{ availabilities?: Json[] }>(
        `/companies/${encodeURIComponent(sn)}/items/${item.pk}/minimal/availabilities/date-range/${from}/${to}/`,
      );
      for (const a of availabilities ?? []) {
        const av = sanitizeAvailability(a, sn, item.pk);
        if (!av) continue;
        const records: RawRecord[] = [];
        if (stored.get(`a:${sn}:${av.pk}`) !== av.rowHash) records.push({ entity: "availabilities", recordId: `${sn}:${av.pk}`, payload: av });
        const { bookings } = await this.api<{ bookings?: Json[] }>(`/companies/${encodeURIComponent(sn)}/availabilities/${av.pk}/bookings/`);
        for (const listed of bookings ?? []) {
          const uuid = str(listed.uuid);
          if (!uuid) continue;
          seen++;
          const context = { pk: av.pk, startAt: str(obj(a).start_at), endAt: str(obj(a).end_at), itemPk: item.pk, itemName: item.name };
          // A rebooked booking moved to another booking; its prices don't matter.
          const b =
            listed.status === "rebooked"
              ? sanitizeBooking(listed, sn, context, true)
              : sanitizeBooking(await this.fetchBooking(sn, uuid), sn, context);
          if (b && stored.get(b.uuid) !== b.rowHash) records.push({ entity: "bookings", recordId: b.uuid, payload: b });
        }
        written += await ctx.emit(records);
      }
    }
    ctx.log("fareharbor range", { company: sn, from, to, bookings: seen, written });
  }

  private async fetchBooking(sn: string, uuid: string): Promise<unknown> {
    const res = await this.api<{ booking?: unknown }>(`/companies/${encodeURIComponent(sn)}/bookings/${encodeURIComponent(uuid)}/?with_payments=yes`);
    return res.booking;
  }

  /**
   * FareHarbor posts the whole booking (or item) to a URL with our shared key.
   * The key is checked, then the booking is re-read from the API so a forged
   * delivery can't plant data.
   */
  async handleWebhook(req: WebhookRequest): Promise<RawRecord[]> {
    const expected = await this.cfg.secrets.get(FAREHARBOR_WEBHOOK_KEY_SECRET);
    if (!expected) throw new WebhookAuthError("FareHarbor webhooks are not configured");
    const given = new URL(req.url).searchParams.get("key") ?? "";
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookAuthError();

    let body: Json;
    try {
      body = obj(JSON.parse(req.rawBody.toString("utf8")));
    } catch {
      return [];
    }
    const booking = obj(body.booking);
    const uuid = str(booking.uuid);
    const sn = str(obj(booking.company).shortname);
    if (uuid && sn && /^[\w-]+$/.test(sn)) {
      const b = sanitizeBooking(await this.fetchBooking(sn, uuid), sn);
      return b ? [{ entity: "bookings", recordId: b.uuid, payload: b }] : [];
    }
    const item = obj(body.item);
    const itemPk = num(item.pk);
    const itemCompany = str(obj(item.company).shortname);
    if (itemPk !== null && itemCompany) return [{ entity: "items", recordId: `${itemCompany}:${itemPk}`, payload: { company: itemCompany, pk: itemPk, name: str(item.name) } }];
    return [];
  }
}

export class BigQueryStoredHashes implements StoredHashes {
  constructor(private readonly bq: BigQuery) {}
  async load(company: string, from: string, to: string) {
    const out = new Map<string, string>();
    for (const [table, prefix, id] of [
      ["bookings", "", "record_id"],
      ["availabilities", "a:", "record_id"],
    ] as const) {
      const [exists] = await this.bq.dataset("raw_fareharbor").table(table).exists();
      if (!exists) continue;
      const [rows] = await this.bq.query({
        query: `
          SELECT ${id} AS id, JSON_VALUE(payload, '$.rowHash') AS row_hash
          FROM \`raw_fareharbor.${table}\`
          WHERE JSON_VALUE(payload, '$.company') = @company
            AND JSON_VALUE(payload, '$.startDate') BETWEEN @from AND @to
          QUALIFY ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY source_updated_at DESC, ingested_at DESC) = 1`,
        params: { company, from, to },
      });
      for (const r of rows as Array<{ id: string; row_hash: string }>) out.set(prefix + r.id, r.row_hash);
    }
    return out;
  }
}
