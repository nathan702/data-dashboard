import type { BusinessLine, IsoDate, RevenueQuery, RevenueSummaryResponse, SourceFreshness } from "@dash/shared";

export interface Warehouse {
  revenueSummary(q: RevenueQuery): Promise<RevenueSummaryResponse>;
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
