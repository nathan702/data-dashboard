import { BigQuery } from "@google-cloud/bigquery";
import {
  BUSINESS_LINES,
  comparisonRange,
  type BusinessLine,
  type Granularity,
  type RevenueMeasure,
  type RevenueQuery,
  type RevenueSummaryResponse,
} from "@dash/shared";
import type { Warehouse } from "./types.js";

// Only these fixed fragments are ever interpolated into SQL. Everything that
// comes from the request is passed as a query parameter.
const BUCKET_SQL: Record<Granularity, string> = {
  day: "revenue_date",
  week: "DATE_TRUNC(revenue_date, WEEK(MONDAY))",
  month: "DATE_TRUNC(revenue_date, MONTH)",
  season: "season_start_date",
};

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
    martsDataset: string,
  ) {
    if (!DATASET_NAME.test(martsDataset)) throw new Error(`Invalid dataset name: ${martsDataset}`);
    this.table = `\`${martsDataset}.fct_revenue_daily\``;
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
    };
    const types = { lines: ["STRING"] };

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
        CAST(${BUCKET_SQL[q.granularity]} AS STRING) AS period,
        business_line,
        ${MEASURE_SQL[q.measure]} AS value
      FROM ${this.table}
      WHERE date_basis = @basis
        AND business_line IN UNNEST(@lines)
        AND revenue_date BETWEEN @start AND @end
      GROUP BY 1, 2
      ORDER BY 1, 2`;

    const [[totalRows], [seriesRows]] = await Promise.all([
      this.bq.query({ query: totalsSql, params, types }),
      this.bq.query({ query: seriesSql, params, types }),
    ]);

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
      series: (seriesRows as SeriesRow[]).map((r) => ({
        period: r.period,
        businessLine: r.business_line as BusinessLine,
        value: round2(Number(r.value)),
      })),
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
