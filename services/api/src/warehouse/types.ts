import type {
  BusinessLine,
  InventoryResponse,
  IsoDate,
  RetailBreakdownQuery,
  RetailBreakdownResponse,
  RetailKpiQuery,
  RetailKpiResponse,
  RetailLine,
  RevenueQuery,
  RevenueSummaryResponse,
  SourceFreshness,
} from "@dash/shared";

export interface Warehouse {
  revenueSummary(q: RevenueQuery): Promise<RevenueSummaryResponse>;
  retailKpis(line: RetailLine, q: RetailKpiQuery): Promise<RetailKpiResponse>;
  retailBreakdown(line: RetailLine, q: RetailBreakdownQuery): Promise<RetailBreakdownResponse>;
  shopifyInventory(): Promise<InventoryResponse>;
}

export interface FreshnessSource {
  freshness(): Promise<SourceFreshness[]>;
}

/** One row of marts.fct_revenue_daily for a single date basis. */
export interface DailyRevenueRow {
  businessLine: BusinessLine;
  date: IsoDate;
  seasonStart: IsoDate;
  gross: number;
  discounts: number;
  refunds: number;
  fees: number;
  transactions: number;
}
