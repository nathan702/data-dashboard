import type {
  AssignmentRow,
  AssignmentUpdate,
  BusinessLineOrUnassigned,
  EnrollmentBreakdownQuery,
  EnrollmentMapQuery,
  EnrollmentMapResponse,
  EnrollmentBreakdownResponse,
  EnrollmentSeason,
  EnrollmentSummaryQuery,
  EnrollmentSummaryResponse,
  InventoryResponse,
  IsoDate,
  RetailBreakdownQuery,
  RetailBreakdownResponse,
  RetailKpiQuery,
  RetailKpiResponse,
  RetailSource,
  RevenueQuery,
  RevenueSummaryResponse,
  Source,
  SourceFreshness,
} from "@dash/shared";
import type { ReferenceTotals } from "../selfCheck.js";

export interface Warehouse {
  revenueSummary(q: RevenueQuery): Promise<RevenueSummaryResponse>;
  retailKpis(source: RetailSource, q: RetailKpiQuery): Promise<RetailKpiResponse>;
  retailBreakdown(source: RetailSource, q: RetailBreakdownQuery): Promise<RetailBreakdownResponse>;
  shopifyInventory(): Promise<InventoryResponse>;
  /** Every assignable value with its effective business line; saved-but-not-yet-applied choices included. */
  assignments(): Promise<{ rows: AssignmentRow[]; pendingRefresh: boolean }>;
  saveAssignments(changes: AssignmentUpdate["changes"], by: string): Promise<void>;
  enrollmentSeasons(businessLine: BusinessLineOrUnassigned | undefined): Promise<EnrollmentSeason[]>;
  enrollmentSummary(q: EnrollmentSummaryQuery): Promise<EnrollmentSummaryResponse>;
  enrollmentMap(q: EnrollmentMapQuery): Promise<EnrollmentMapResponse>;
  enrollmentBreakdown(q: EnrollmentBreakdownQuery): Promise<EnrollmentBreakdownResponse>;
  /** Plain totals straight from the tables, for the deploy self-check. */
  referenceTotals(start: string, end: string): Promise<ReferenceTotals>;
}

export interface FreshnessSource {
  freshness(): Promise<SourceFreshness[]>;
}

/** One row of marts.fct_revenue_daily for a single date basis. */
export interface DailyRevenueRow {
  businessLine: BusinessLineOrUnassigned;
  source: Source;
  date: IsoDate;
  seasonStart: IsoDate;
  gross: number;
  discounts: number;
  refunds: number;
  fees: number;
  transactions: number;
}
