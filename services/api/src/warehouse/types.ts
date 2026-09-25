import type {
  AssignmentRow,
  AssignmentUpdate,
  BusinessLineOrUnassigned,
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

export interface Warehouse {
  revenueSummary(q: RevenueQuery): Promise<RevenueSummaryResponse>;
  retailKpis(source: RetailSource, q: RetailKpiQuery): Promise<RetailKpiResponse>;
  retailBreakdown(source: RetailSource, q: RetailBreakdownQuery): Promise<RetailBreakdownResponse>;
  shopifyInventory(): Promise<InventoryResponse>;
  /** Every assignable value with its effective business line; saved-but-not-yet-applied choices included. */
  assignments(): Promise<{ rows: AssignmentRow[]; pendingRefresh: boolean }>;
  saveAssignments(changes: AssignmentUpdate["changes"], by: string): Promise<void>;
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
