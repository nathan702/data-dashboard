import { z } from "zod";
import { BUSINESS_LINES_WITH_UNASSIGNED, type BusinessLineOrUnassigned } from "./businessLines.js";
import { enrollmentFiltersSchema } from "./campminder.js";
import { jsonQueryParam } from "./params.js";

/**
 * A season's tuition and payments from Campminder's Financial report, for
 * one business line (or all). Amounts in USD, positive.
 */
export const campminderFinanceQuerySchema = z.object({
  season: z.coerce.number().int().min(2000).max(2100),
  businessLine: z.enum(BUSINESS_LINES_WITH_UNASSIGNED).optional(),
  /**
   * The Camp page's drill-down filters. With any, only lines for matching
   * camper-sessions count: a session's own charges, discounts and payments,
   * found through the camper's enrollment in that session.
   */
  filters: jsonQueryParam(enrollmentFiltersSchema),
});
export type CampminderFinanceQuery = z.infer<typeof campminderFinanceQuerySchema>;

export interface CampminderFinanceSummary {
  season: number;
  businessLine: BusinessLineOrUnassigned | null;
  /** Charges (debits). */
  charges: number;
  /** Discounts, aid and other credits. */
  discounts: number;
  /** Charges minus discounts. */
  netTuition: number;
  payments: number;
  refunds: number;
  /** Payments minus refunds. */
  netCollected: number;
  /** What households with a balance still owe (their whole season, every line). */
  balanceOwed: number;
  householdsOwing: number;
  /** Credit held for households that have paid more than they owe. */
  creditHeld: number;
  households: number;
  /** Filters applied: only lines tied to a matching camper-session (no unsplit payments, refunds or household fees). */
  filtered: boolean;
}

/**
 * Line items that are extras wherever they're filed: Campminder puts lunches,
 * gear bags and backpacks under Summer Camp, next to tuition. Case-insensitive;
 * the same pattern runs in BigQuery (RE2) and in JavaScript.
 */
export const CAMP_EXTRA_ITEM_PATTERN = String.raw`\blunch\b|gear\s*bag|backpack`;

/** Whether a charge or credit is an extra: in the Miscellaneous or System category (or none), or named like one. */
export function isCampExtra(category: string | null, item: string | null): boolean {
  if (!item) return false;
  return category === null || category === "Miscellaneous" || category === "System" || new RegExp(CAMP_EXTRA_ITEM_PATTERN, "i").test(item);
}

/**
 * Camp extras: line items that aren't tuition (Week N Lunch, Gear Bag,
 * Backpack, cancellation fees…): charges and credits in the Miscellaneous or
 * System financial category (or none), plus lunches, gear bags and backpacks
 * in any category. A lunch's session is on its own line; an item without
 * one goes with the camper's first enrolled session that season.
 */
export const campminderExtrasQuerySchema = z.object({
  season: z.coerce.number().int().min(2000).max(2100),
  businessLine: z.enum(BUSINESS_LINES_WITH_UNASSIGNED).optional(),
});
export type CampminderExtrasQuery = z.infer<typeof campminderExtrasQuerySchema>;

/** One group of extras lines from the warehouse: a season, an item (weeks folded into "Week N"), a week and a session group. */
export interface CampminderExtrasRow {
  season: number;
  /** Line item name with any week folded in: "Week N Lunch", "Gear Bag". */
  item: string;
  week: number | null;
  /** The line's own session group, else the camper's first enrolled session's. */
  sessionGroup: string | null;
  /** Lines charged, less reversed ones (each line is one item). */
  count: number;
  /** Charges less credits and reversals. */
  revenue: number;
}

export interface CampminderExtrasItem {
  item: string;
  count: number;
  revenue: number;
  /** Last season, posted by the same date a year ago. */
  lastCount: number;
  lastRevenue: number;
}

export interface CampminderExtras {
  season: number;
  businessLine: BusinessLineOrUnassigned | null;
  /** Last season counts lines posted on or before this date (a year before today). */
  lastSeasonCutoff: string;
  items: CampminderExtrasItem[];
  /** This season by item, week and session group. */
  bySession: Array<Omit<CampminderExtrasRow, "season">>;
}

/** Folds warehouse rows into the extras response (this season's rows and last season's at the same point). */
export function summarizeCampminderExtras(
  rows: CampminderExtrasRow[],
  q: { season: number; businessLine?: BusinessLineOrUnassigned | null },
  lastSeasonCutoff: string,
): CampminderExtras {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const items = new Map<string, CampminderExtrasItem>();
  const bySession: CampminderExtras["bySession"] = [];
  for (const r of rows) {
    const cur = r.season === q.season;
    if (!cur && r.season !== q.season - 1) continue;
    const it = items.get(r.item) ?? { item: r.item, count: 0, revenue: 0, lastCount: 0, lastRevenue: 0 };
    if (cur) {
      it.count += r.count;
      it.revenue += r.revenue;
      bySession.push({ item: r.item, week: r.week, sessionGroup: r.sessionGroup, count: r.count, revenue: r2(r.revenue) });
    } else {
      it.lastCount += r.count;
      it.lastRevenue += r.revenue;
    }
    items.set(r.item, it);
  }
  const out = [...items.values()]
    .map((i) => ({ ...i, revenue: r2(i.revenue), lastRevenue: r2(i.lastRevenue) }))
    .filter((i) => i.count !== 0 || i.revenue !== 0 || i.lastCount !== 0 || i.lastRevenue !== 0)
    .sort((a, b) => b.revenue - a.revenue || b.lastRevenue - a.lastRevenue || a.item.localeCompare(b.item));
  bySession.sort((a, b) => a.item.localeCompare(b.item) || (a.week ?? 0) - (b.week ?? 0) || (a.sessionGroup ?? "").localeCompare(b.sessionGroup ?? ""));
  return { season: q.season, businessLine: q.businessLine ?? null, lastSeasonCutoff, items: out, bySession };
}

/** The date a year before `today` (YYYY-MM-DD; Feb 29 → Feb 28). */
export function yearBefore(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const day = m === 2 && d === 29 ? 28 : d;
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
