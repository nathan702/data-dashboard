import { z } from "zod";
import { BUSINESS_LINES, type BusinessLine } from "./businessLines.js";
import { addDays, isIsoDate, type IsoDate } from "./dates.js";

/**
 * FareHarbor bookings by activity day (a "night" for the Haunted Forest), this
 * season against last season. Days are matched across years by the closest
 * same weekday: 364 days earlier (Friday 10/2/2026 ↔ Friday 10/3/2025).
 */

export const TICKET_TYPES = ["town", "trail", "combo", "package", "other"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  town: "Town",
  trail: "Trail",
  combo: "Combo",
  package: "Packages",
  other: "Other",
};
/** Ticket types compared year over year (packages are new and kept apart). */
export const CORE_TICKET_TYPES: TicketType[] = ["town", "trail", "combo"];

/** An item's ticket type from its name; an entry on Settings wins. */
export function ticketTypeFor(itemName: string | null, overrides: Record<string, TicketType> = {}): TicketType {
  const name = itemName ?? "";
  const set = overrides[name];
  if (set) return set;
  const n = name.toLowerCase();
  if (n.includes("combo")) return "combo";
  if (/upside|express|dinner|package/.test(n)) return "package";
  if (n.includes("trail")) return "trail";
  if (n.includes("town")) return "town";
  return "other";
}

/** Same weekday, closest date, one year back. */
export const MATCH_OFFSET_DAYS = 364;
export const matchingDay = (date: IsoDate) => addDays(date, -MATCH_OFFSET_DAYS);

/** Days between buying and the activity, finest grain the page shows. */
export const LEAD_BUCKETS = ["0", "1", "2-3", "4-6", "7-13", "14-20", "21-27", "28-41", "42-55", "56+"] as const;
export type LeadBucket = (typeof LEAD_BUCKETS)[number];
export const LEAD_BUCKET_LABEL: Record<LeadBucket, string> = {
  "0": "Same day",
  "1": "1 day",
  "2-3": "2-3 days",
  "4-6": "4-6 days",
  "7-13": "1-2 weeks",
  "14-20": "2-3 weeks",
  "21-27": "3-4 weeks",
  "28-41": "4-6 weeks",
  "42-55": "6-8 weeks",
  "56+": "8+ weeks",
};
/** Coarser groups for the per-weekend bars. */
export const LEAD_GROUPS: Array<{ label: string; buckets: LeadBucket[] }> = [
  { label: "Same day", buckets: ["0"] },
  { label: "1-3 days", buckets: ["1", "2-3"] },
  { label: "4-6 days", buckets: ["4-6"] },
  { label: "1-2 weeks", buckets: ["7-13"] },
  { label: "2-4 weeks", buckets: ["14-20", "21-27"] },
  { label: "4+ weeks", buckets: ["28-41", "42-55", "56+"] },
];

export function leadBucket(days: number): LeadBucket {
  if (days <= 0) return "0";
  if (days === 1) return "1";
  if (days <= 3) return "2-3";
  if (days <= 6) return "4-6";
  if (days <= 13) return "7-13";
  if (days <= 20) return "14-20";
  if (days <= 27) return "21-27";
  if (days <= 41) return "28-41";
  if (days <= 55) return "42-55";
  return "56+";
}

/** A day the business was closed (weather, cancelled): left out of both years, with its match. */
export interface Closure {
  businessLine: BusinessLine;
  date: IsoDate;
  note: string;
}

export interface FareharborSettings {
  closures: Closure[];
  /** FareHarbor item name → ticket type, where the name alone doesn't say. */
  itemTypes: Record<string, TicketType>;
}

export const DEFAULT_FAREHARBOR_SETTINGS: FareharborSettings = {
  closures: [
    { businessLine: "haunted_forest", date: "2025-10-19", note: "Weather" },
    { businessLine: "haunted_forest", date: "2026-10-11", note: "Weather" },
    { businessLine: "haunted_forest", date: "2026-11-08", note: "Cancelled" },
  ],
  itemTypes: {},
};

export const fareharborSettingsSchema = z.object({
  closures: z
    .array(z.object({ businessLine: z.enum(BUSINESS_LINES), date: z.string().refine(isIsoDate), note: z.string().max(200) }))
    .max(500),
  itemTypes: z.record(z.string().min(1).max(300), z.enum(TICKET_TYPES)),
});

/** Lines whose FareHarbor days are nights (one row per night); others group by week. */
export const NIGHTLY_LINES: BusinessLine[] = ["haunted_forest"];

export const fareharborDaysQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES),
  season: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type FareharborDaysQuery = z.infer<typeof fareharborDaysQuerySchema>;

/**
 * One activity day (or week) × item × lead-time bucket. `revenue` is booking
 * totals less refunds; guests leave out cancelled bookings. The `…AtSamePoint`
 * figures count only bookings made by the same point last year (364 days
 * before today).
 */
export interface FareharborDayRow {
  /** The night, or the Monday of the week. */
  day: IsoDate;
  item: string;
  lead: LeadBucket;
  revenue: number;
  guests: number;
  bookings: number;
  revenueAtSamePoint: number;
  guestsAtSamePoint: number;
}

export interface FareharborDaysResponse {
  businessLine: BusinessLine;
  season: number;
  /** Seasons with bookings, newest first. */
  seasons: number[];
  nightly: boolean;
  /** This season's and last season's date ranges. */
  current: { start: IsoDate; end: IsoDate };
  previous: { start: IsoDate; end: IsoDate };
  /** Today, or the season's last day for a past season: days before it are "held". */
  asOf: IsoDate;
  /** Last season's bookings count as "at the same point" when made on or before this day. */
  samePointCutoff: IsoDate;
  rows: FareharborDayRow[];
  closures: Closure[];
  itemTypes: Record<string, TicketType>;
}
