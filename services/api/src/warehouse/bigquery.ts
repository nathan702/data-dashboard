import { BigQuery } from "@google-cloud/bigquery";
import {
  BUSINESS_LINES,
  comparisonRange,
  daysBetweenInclusive,
  DEFAULT_SEASON_CONFIG,
  type BusinessLine,
  type Granularity,
  type InventoryResponse,
  type RetailBreakdownQuery,
  type RetailBreakdownResponse,
  type RetailKpiQuery,
  type RetailKpiResponse,
  type RetailLine,
  type RevenueMeasure,
  type RevenueQuery,
  type RevenueSummaryResponse,
} from "@dash/shared";
import { toKpis } from "./retail.js";
import { breakdownSql, inventorySql, kpiSql } from "./retailSql.js";
import type { Warehouse } from "./types.js";

// Only these fixed fragments are ever interpolated into SQL. Everything that
// comes from the request is passed as a query parameter.
const { startMonth: SM, startDay: SD } = DEFAULT_SEASON_CONFIG;

/** Bucket start date for a DATE expression. `d` is always a fixed SQL fragment. */
function bucketSql(g: Granularity, d: string): string {
  switch (g) {
    case "day":
      return d;
    case "week":
      return `DATE_TRUNC(${d}, WEEK(MONDAY))`;
    case "month":
      return `DATE_TRUNC(${d}, MONTH)`;
    case "season":
      // First day of the Campminder season containing d (same rule as dim_date).
      return `DATE(IF(${d} >= DATE(EXTRACT(YEAR FROM ${d}), ${SM}, ${SD}), EXTRACT(YEAR FROM ${d}), EXTRACT(YEAR FROM ${d}) - 1), ${SM}, ${SD})`;
  }
}

const MEASURE_SQL: Record<RevenueMeasure, string> = {
  gross: "SUM(gross)",
  net: "SUM(gross - discounts - refunds)",
  net_after_fees: "SUM(gross - discounts - refunds - fees)",
};

const DATASET_NAME = /^[A-Za-z0-9_]+$/;

export class BigQueryWarehouse implements Warehouse {
  private readonly table: string;

  constructor(
    private readonly bq: BigQuery,
    private readonly martsDataset: string,
  ) {
    if (!DATASET_NAME.test(martsDataset)) throw new Error(`Invalid dataset name: ${martsDataset}`);
    this.table = `\`${martsDataset}.fct_revenue_daily\``;
  }

  async retailKpis(line: RetailLine, q: RetailKpiQuery): Promise<RetailKpiResponse> {
    const cmp = comparisonRange({ start: q.start, end: q.end }, q.compare);
    const [rows] = await this.bq.query({
      query: kpiSql(this.martsDataset),
      params: {
        line,
        start: q.start,
        end: q.end,
        has_cmp: cmp !== null,
        cmp_start: cmp?.start ?? q.start,
        cmp_end: cmp?.end ?? q.end,
      },
    });
    const find = (p: string) => (rows as Array<Record<string, number> & { period: string }>).find((r) => r.period === p) ?? {};
    return {
      line,
      range: { start: q.start, end: q.end },
      comparisonRange: cmp,
      current: toKpis(find("current")),
      comparison: cmp ? toKpis(find("comparison")) : null,
    };
  }

  async retailBreakdown(line: RetailLine, q: RetailBreakdownQuery): Promise<RetailBreakdownResponse> {
    const [rows] = await this.bq.query({
      query: breakdownSql(this.martsDataset, q.dimension),
      params: { line, start: q.start, end: q.end, limit_plus_one: q.limit + 1 },
    });
    const typed = rows as Array<{ key: string; detail: string | null; orders: number; units: number; gross: number; discounts: number; net: number }>;
    return {
      line,
      dimension: q.dimension,
      range: { start: q.start, end: q.end },
      truncated: typed.length > q.limit,
      rows: typed.slice(0, q.limit).map((r) => ({
        key: r.key,
        detail: r.detail,
        orders: Number(r.orders),
        units: round2(Number(r.units)),
        gross: round2(Number(r.gross)),
        discounts: round2(Number(r.discounts)),
        net: round2(Number(r.net)),
      })),
    };
  }

  async shopifyInventory(): Promise<InventoryResponse> {
    const [rows] = await this.bq.query({ query: inventorySql(this.martsDataset) });
    const typed = rows as Array<{ product: string; variant: string | null; sku: string | null; location: string; available: number; on_hand: number; snapshot_at: { value: string } | string | null }>;
    const at = typed[0]?.snapshot_at;
    return {
      snapshotAt: at ? (typeof at === "string" ? at : at.value) : null,
      rows: typed.map((r) => ({
        product: r.product,
        variant: r.variant,
        sku: r.sku,
        location: r.location,
        available: Number(r.available),
        onHand: Number(r.on_hand),
      })),
    };
  }

  async revenueSummary(q: RevenueQuery): Promise<RevenueSummaryResponse> {
    const lines: BusinessLine[] = q.businessLines?.length ? q.businessLines : [...BUSINESS_LINES];
    const cmp = comparisonRange({ start: q.start, end: q.end }, q.compare);
    const params = {
      basis: q.basis,
      lines,
      start: q.start,
      end: q.end,
      has_cmp: cmp !== null,
      cmp_start: cmp?.start ?? q.start,
      cmp_end: cmp?.end ?? q.end,
      shift_days: daysBetweenInclusive(q.start, q.end),
    };
    const types = { lines: ["STRING"] };
    // Comparison rows moved onto the current period (see alignToCurrent in @dash/shared).
    const aligned =
      q.compare === "previous_year" ? "DATE_ADD(revenue_date, INTERVAL 1 YEAR)" : "DATE_ADD(revenue_date, INTERVAL @shift_days DAY)";

    const totalsSql = `
      SELECT
        business_line,
        IF(revenue_date BETWEEN @start AND @end, 'current', 'comparison') AS period,
        SUM(gross) AS gross, SUM(discounts) AS discounts, SUM(refunds) AS refunds,
        SUM(fees) AS fees, SUM(transactions) AS transactions
      FROM ${this.table}
      WHERE date_basis = @basis
        AND business_line IN UNNEST(@lines)
        AND (revenue_date BETWEEN @start AND @end
             OR (@has_cmp AND revenue_date BETWEEN @cmp_start AND @cmp_end))
      GROUP BY 1, 2`;

    const seriesSql = `
      SELECT
        CAST(${bucketSql(q.granularity, "revenue_date")} AS STRING) AS period,
        business_line,
        ${MEASURE_SQL[q.measure]} AS value
      FROM ${this.table}
      WHERE date_basis = @basis
        AND business_line IN UNNEST(@lines)
        AND revenue_date BETWEEN @start AND @end
      GROUP BY 1, 2
      ORDER BY 1, 2`;

    const comparisonSeriesSql = `
      SELECT
        CAST(${bucketSql(q.granularity, aligned)} AS STRING) AS period,
        business_line,
        ${MEASURE_SQL[q.measure]} AS value
      FROM ${this.table}
      WHERE date_basis = @basis
        AND business_line IN UNNEST(@lines)
        AND revenue_date BETWEEN @cmp_start AND @cmp_end
      GROUP BY 1, 2
      ORDER BY 1, 2`;

    const [[totalRows], [seriesRows], cmpResult] = await Promise.all([
      this.bq.query({ query: totalsSql, params, types }),
      this.bq.query({ query: seriesSql, params, types }),
      cmp ? this.bq.query({ query: comparisonSeriesSql, params, types }) : Promise.resolve([[]]),
    ]);
    const toPoints = (rows: SeriesRow[]) =>
      rows.map((r) => ({ period: r.period, businessLine: r.business_line as BusinessLine, value: round2(Number(r.value)) }));

    const find = (line: string, period: string) =>
      (totalRows as TotalsRow[]).find((r) => r.business_line === line && r.period === period);

    return {
      range: { start: q.start, end: q.end },
      comparisonRange: cmp,
      byLine: lines.map((l) => ({
        businessLine: l,
        current: toTotals(find(l, "current")),
        comparison: cmp ? toTotals(find(l, "comparison")) : null,
      })),
      series: toPoints(seriesRows as SeriesRow[]),
      comparisonSeries: toPoints(cmpResult[0] as SeriesRow[]),
      generatedAt: new Date().toISOString(),
    };
  }
}

interface TotalsRow {
  business_line: string;
  period: string;
  gross: number;
  discounts: number;
  refunds: number;
  fees: number;
  transactions: number;
}

interface SeriesRow {
  period: string;
  business_line: string;
  value: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function toTotals(r: TotalsRow | undefined) {
  const gross = Number(r?.gross ?? 0);
  const discounts = Number(r?.discounts ?? 0);
  const refunds = Number(r?.refunds ?? 0);
  const fees = Number(r?.fees ?? 0);
  const net = gross - discounts - refunds;
  return {
    gross: round2(gross),
    discounts: round2(discounts),
    refunds: round2(refunds),
    fees: round2(fees),
    net: round2(net),
    netAfterFees: round2(net - fees),
    transactions: Number(r?.transactions ?? 0),
  };
}
