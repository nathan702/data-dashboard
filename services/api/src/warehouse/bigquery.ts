import { BigQuery } from "@google-cloud/bigquery";
import {
  comparisonRange,
  daysBetweenInclusive,
  DEFAULT_SEASON_CONFIG,
  type AssignmentRow,
  type AssignmentUpdate,
  type BusinessLineOrUnassigned,
  type Granularity,
  type InventoryResponse,
  type RetailBreakdownQuery,
  type RetailBreakdownResponse,
  type RetailKpiQuery,
  type RetailKpiResponse,
  type RetailSource,
  type RevenueMeasure,
  type RevenueQuery,
  type RevenueSummaryResponse,
  type Source,
} from "@dash/shared";
import { toKpis } from "./retail.js";
import { assignmentsBuiltAtSql, assignmentsSql, breakdownSql, inventorySql, kpiSql, saveAssignmentsSql } from "./retailSql.js";
import { groupKeys } from "./summarize.js";
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

const GROUP_COLUMN = { business_line: "business_line", source: "source" } as const;

const DATASET_NAME = /^[A-Za-z0-9_]+$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

export class BigQueryWarehouse implements Warehouse {
  private readonly table: string;

  constructor(
    private readonly bq: BigQuery,
    private readonly martsDataset: string,
    private readonly configDataset = "config",
    private readonly location = "US",
  ) {
    for (const d of [martsDataset, configDataset]) if (!DATASET_NAME.test(d)) throw new Error(`Invalid dataset name: ${d}`);
    this.table = `\`${martsDataset}.fct_revenue_daily\``;
  }

  async revenueSummary(q: RevenueQuery): Promise<RevenueSummaryResponse> {
    const cmp = comparisonRange({ start: q.start, end: q.end }, q.compare);
    const group = GROUP_COLUMN[q.groupBy];
    const params = {
      basis: q.basis,
      business_lines: q.businessLines ?? [],
      sources: q.sources ?? [],
      start: q.start,
      end: q.end,
      has_cmp: cmp !== null,
      cmp_start: cmp?.start ?? q.start,
      cmp_end: cmp?.end ?? q.end,
      shift_days: daysBetweenInclusive(q.start, q.end),
    };
    const types = { business_lines: ["STRING"], sources: ["STRING"] };
    // The client sends an empty array parameter as NULL, and ARRAY_LENGTH(NULL)
    // is NULL, so "no filter" must be spelled with COALESCE or every row drops.
    const filters = `
        date_basis = @basis
        AND (COALESCE(ARRAY_LENGTH(@business_lines), 0) = 0 OR business_line IN UNNEST(@business_lines))
        AND (COALESCE(ARRAY_LENGTH(@sources), 0) = 0 OR source IN UNNEST(@sources))`;
    // Comparison rows moved onto the current period (see alignToCurrent in @dash/shared).
    const aligned =
      q.compare === "previous_year" ? "DATE_ADD(revenue_date, INTERVAL 1 YEAR)" : "DATE_ADD(revenue_date, INTERVAL @shift_days DAY)";

    const totalsSql = `
      SELECT
        ${group} AS grp,
        IF(revenue_date BETWEEN @start AND @end, 'current', 'comparison') AS period,
        SUM(gross) AS gross, SUM(discounts) AS discounts, SUM(refunds) AS refunds,
        SUM(fees) AS fees, SUM(transactions) AS transactions
      FROM ${this.table}
      WHERE ${filters}
        AND (revenue_date BETWEEN @start AND @end
             OR (@has_cmp AND revenue_date BETWEEN @cmp_start AND @cmp_end))
      GROUP BY 1, 2`;

    const seriesSql = (dateExpr: string, from: string, to: string) => `
      SELECT CAST(${bucketSql(q.granularity, dateExpr)} AS STRING) AS period, ${group} AS grp, ${MEASURE_SQL[q.measure]} AS value
      FROM ${this.table}
      WHERE ${filters} AND revenue_date BETWEEN ${from} AND ${to}
      GROUP BY 1, 2
      ORDER BY 1, 2`;

    const run = (query: string) => this.bq.query({ query, params, types, location: this.location }).then(([rows]) => rows);
    const [totalRows, seriesRows, cmpRows] = await Promise.all([
      run(totalsSql),
      run(seriesSql("revenue_date", "@start", "@end")),
      cmp ? run(seriesSql(aligned, "@cmp_start", "@cmp_end")) : Promise.resolve([]),
    ]);

    const find = (key: string, period: string) => (totalRows as TotalsRow[]).find((r) => r.grp === key && r.period === period);
    const toPoints = (rows: SeriesRow[]) => rows.map((r) => ({ period: r.period, key: r.grp, value: round2(Number(r.value)) }));

    return {
      range: { start: q.start, end: q.end },
      comparisonRange: cmp,
      groupBy: q.groupBy,
      groups: groupKeys(q).map((key) => ({
        key,
        current: toTotals(find(key, "current")),
        comparison: cmp ? toTotals(find(key, "comparison")) : null,
      })),
      series: toPoints(seriesRows as SeriesRow[]),
      comparisonSeries: toPoints(cmpRows as SeriesRow[]),
      generatedAt: new Date().toISOString(),
    };
  }

  private retailParams(source: RetailSource, businessLine: BusinessLineOrUnassigned | undefined) {
    return {
      params: { source, business_line: businessLine ?? null },
      types: { business_line: "STRING" },
    };
  }

  async retailKpis(source: RetailSource, q: RetailKpiQuery): Promise<RetailKpiResponse> {
    const cmp = comparisonRange({ start: q.start, end: q.end }, q.compare);
    const base = this.retailParams(source, q.businessLine);
    const [rows] = await this.bq.query({
      query: kpiSql(this.martsDataset),
      params: {
        ...base.params,
        start: q.start,
        end: q.end,
        has_cmp: cmp !== null,
        cmp_start: cmp?.start ?? q.start,
        cmp_end: cmp?.end ?? q.end,
      },
      types: base.types,
      location: this.location,
    });
    const find = (p: string) => (rows as Array<Record<string, number> & { period: string }>).find((r) => r.period === p) ?? {};
    return {
      source,
      businessLine: q.businessLine ?? null,
      range: { start: q.start, end: q.end },
      comparisonRange: cmp,
      current: toKpis(find("current")),
      comparison: cmp ? toKpis(find("comparison")) : null,
    };
  }

  async retailBreakdown(source: RetailSource, q: RetailBreakdownQuery): Promise<RetailBreakdownResponse> {
    const base = this.retailParams(source, q.businessLine);
    const [rows] = await this.bq.query({
      query: breakdownSql(this.martsDataset, q.dimension),
      params: { ...base.params, start: q.start, end: q.end, limit_plus_one: q.limit + 1 },
      types: base.types,
      location: this.location,
    });
    const typed = rows as Array<{ key: string; detail: string | null; orders: number; units: number; gross: number; discounts: number; net: number }>;
    return {
      source,
      businessLine: q.businessLine ?? null,
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
    const [rows] = await this.bq.query({ query: inventorySql(this.martsDataset), location: this.location });
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

  async assignments(): Promise<{ rows: AssignmentRow[]; pendingRefresh: boolean }> {
    const [[rows], [built]] = await Promise.all([
      this.bq.query({ query: assignmentsSql(this.martsDataset, this.configDataset), location: this.location }),
      this.bq.query({ query: assignmentsBuiltAtSql(this.martsDataset), location: this.location }),
    ]);
    const builtAt = tsValue((built as Array<{ built_at: unknown }>)[0]?.built_at);
    const typed = rows as Array<{
      source: Source;
      kind: string;
      assign_key: string;
      label: string;
      business_line: BusinessLineOrUnassigned;
      origin: AssignmentRow["origin"];
      last_activity: string | null;
      net_12m: number | string;
      saved_at: unknown;
    }>;
    let pendingRefresh = false;
    const out = typed.map((r) => {
      const savedAt = tsValue(r.saved_at);
      if (savedAt && (!builtAt || savedAt > builtAt)) pendingRefresh = true;
      return {
        source: r.source,
        kind: r.kind,
        key: r.assign_key,
        label: r.label,
        businessLine: r.business_line,
        origin: r.origin,
        lastActivity: r.last_activity,
        netLast12Months: round2(Number(r.net_12m)),
      };
    });
    return { rows: out, pendingRefresh };
  }

  async referenceTotals(start: string, end: string) {
    // Deliberately simple SQL with scalar parameters only.
    const [[rev], [retail]] = await Promise.all([
      this.bq.query({
        query: `SELECT COALESCE(SUM(gross), 0) AS gross FROM ${this.table} WHERE date_basis = 'booked' AND revenue_date BETWEEN @start AND @end`,
        params: { start, end },
        location: this.location,
      }),
      this.bq.query({
        query: `SELECT source, COALESCE(SUM(gross), 0) AS gross FROM \`${this.martsDataset}.fct_retail_line_items\` WHERE sale_date BETWEEN @start AND @end GROUP BY 1`,
        params: { start, end },
        location: this.location,
      }),
    ]);
    const bySource = new Map((retail as Array<{ source: string; gross: unknown }>).map((r) => [r.source, Number(r.gross)]));
    return {
      revenueGross: Number((rev as Array<{ gross: unknown }>)[0]?.gross ?? 0),
      retailGross: { shopify: bySource.get("shopify") ?? 0, square: bySource.get("square") ?? 0 },
    };
  }

  async saveAssignments(changes: AssignmentUpdate["changes"], by: string): Promise<void> {
    await this.bq.query({
      query: saveAssignmentsSql(this.configDataset),
      params: {
        by,
        changes: changes.map((c) => ({ source: c.source, kind: c.kind, assign_key: c.key, business_line: c.businessLine })),
      },
      types: { changes: [{ source: "STRING", kind: "STRING", assign_key: "STRING", business_line: "STRING" }] },
      location: this.location,
    });
  }
}

function tsValue(v: unknown): number | null {
  if (!v) return null;
  const s = typeof v === "string" ? v : (v as { value?: string }).value;
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
}

interface TotalsRow {
  grp: string;
  period: string;
  gross: number;
  discounts: number;
  refunds: number;
  fees: number;
  transactions: number;
}

interface SeriesRow {
  period: string;
  grp: string;
  value: number;
}

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
