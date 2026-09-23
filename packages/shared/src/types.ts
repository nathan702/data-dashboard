import type { BusinessLine } from "./businessLines.js";
import type { IsoDate } from "./dates.js";

export type SyncStatus = "ok" | "running" | "error" | "never_run";

/** Per-source sync state, stored in Firestore at sync_state/{source}. */
export interface SourceFreshness {
  source: BusinessLine;
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

export interface RevenueByLine {
  businessLine: BusinessLine;
  current: RevenueTotals;
  comparison: RevenueTotals | null;
}

export interface RevenueSeriesPoint {
  period: IsoDate;
  businessLine: BusinessLine;
  value: number;
}

export interface RevenueSummaryResponse {
  range: { start: IsoDate; end: IsoDate };
  comparisonRange: { start: IsoDate; end: IsoDate } | null;
  byLine: RevenueByLine[];
  series: RevenueSeriesPoint[];
  generatedAt: string;
}

export interface MeResponse {
  email: string;
  name: string | null;
  isAdmin: boolean;
}
