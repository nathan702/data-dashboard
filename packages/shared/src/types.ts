import type { IsoDate } from "./dates.js";
import type { Source } from "./sources.js";

export type SyncStatus = "ok" | "running" | "error" | "never_run";

/** Per-source sync state, stored in Firestore at sync_state/{source}. */
export interface SourceFreshness {
  source: Source;
  status: SyncStatus;
  /** Most recent time new data landed, from any path (webhook, poll, file). */
  lastDataAt: string | null;
  /** Most recent successfully completed scheduled/backfill run. */
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface RevenueTotals {
  gross: number;
  discounts: number;
  refunds: number;
  fees: number;
  net: number;
  netAfterFees: number;
  transactions: number;
}

/** Totals for one group: a business line id (or "unassigned") or a source id, per the query's groupBy. */
export interface RevenueGroup {
  key: string;
  current: RevenueTotals;
  comparison: RevenueTotals | null;
}

export interface RevenueSeriesPoint {
  period: IsoDate;
  key: string;
  value: number;
}

export interface RevenueSummaryResponse {
  range: { start: IsoDate; end: IsoDate };
  comparisonRange: { start: IsoDate; end: IsoDate } | null;
  groupBy: "business_line" | "source";
  groups: RevenueGroup[];
  series: RevenueSeriesPoint[];
  /**
   * The comparison period's values, moved onto the current period's buckets
   * (e.g. last year's week of Jun 2 is reported as this year's week of Jun 2)
   * so both can be drawn on the same chart. Empty when there's no comparison.
   */
  comparisonSeries: RevenueSeriesPoint[];
  generatedAt: string;
}

export interface MeResponse {
  email: string;
  name: string | null;
  isAdmin: boolean;
  /** No admin list set in Firestore config/access yet, so everyone is an admin. */
  adminsUnconfigured: boolean;
}
