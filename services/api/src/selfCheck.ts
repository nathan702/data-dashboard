import {
  addDays,
  CALENDAR_YEAR,
  campminderCalendar,
  easternDate,
  RETAIL_SOURCES,
  reportSpecSchema,
  STARTER_REPORTS,
  type RetailSource,
} from "@dash/shared";
import type { SchoolMap } from "./warehouse/reportSql.js";
import type { Warehouse } from "./warehouse/types.js";

/**
 * Deploy-time check that the API's own queries agree with totals computed
 * straight from the tables. Catches bugs that only show up against real
 * BigQuery (e.g. parameters arriving differently than in tests). Reports
 * pass/fail per check, never the numbers themselves.
 */
export interface ReferenceTotals {
  /** SUM(gross) of fct_revenue_daily, booked basis, over the range. */
  revenueGross: number;
  /** SUM(gross) of fct_retail_line_items per platform over the range. */
  retailGross: Record<RetailSource, number>;
  /** Enrolled camper-sessions in the newest Campminder season (null before any sync). */
  enrollments: { season: number; count: number } | null;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const TOLERANCE = 0.5;
const close = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export async function runSelfCheck(
  warehouse: Warehouse,
  reference: (start: string, end: string) => Promise<ReferenceTotals>,
  today = easternDate(),
): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const end = today;
  const start = addDays(today, -89);
  const checks: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string | null>) => {
    try {
      const problem = await fn();
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) });
    }
  };

  let ref: ReferenceTotals | null = null;
  await check("reference totals", async () => {
    ref = await reference(start, end);
    return null;
  });

  const base = { start, end, basis: "booked" as const, measure: "gross" as const, granularity: "week" as const, compare: "none" as const };
  for (const groupBy of ["business_line", "source"] as const) {
    await check(`revenue summary by ${groupBy} matches tables`, async () => {
      const r = await warehouse.revenueSummary({ ...base, groupBy }, CALENDAR_YEAR);
      const total = sum(r.groups.map((g) => g.current.gross));
      const seriesTotal = sum(r.series.map((p) => p.value));
      if (!ref) return "no reference";
      if (!close(total, ref.revenueGross)) return "group totals differ from table total";
      if (!close(seriesTotal, ref.revenueGross)) return "chart series differ from table total";
      return null;
    });
  }

  for (const source of RETAIL_SOURCES) {
    await check(`${source} sales detail matches tables`, async () => {
      const [kpis, breakdown] = await Promise.all([
        warehouse.retailKpis(source, { start, end, compare: "none", filters: {} }),
        warehouse.retailBreakdown(source, { start, end, dimension: "category", limit: 5000, filters: {} }),
      ]);
      if (!ref) return "no reference";
      const expected = ref.retailGross[source];
      if (!close(kpis.current.gross, expected)) return "order totals differ from table total";
      if (!breakdown.truncated && !close(sum(breakdown.rows.map((r) => r.gross)), expected)) return "breakdown differs from table total";
      // Drill-down: filtering to the top category must give that category's numbers.
      const top = breakdown.rows[0];
      if (top) {
        const filters = { category: [top.key] };
        const [fk, fb] = await Promise.all([
          warehouse.retailKpis(source, { start, end, compare: "none", filters }),
          warehouse.retailBreakdown(source, { start, end, dimension: "item", limit: 5000, filters }),
        ]);
        if (!fk.filtered || !close(fk.current.gross, top.gross)) return "filtered totals differ from the category's row";
        if (!fb.truncated && !close(sum(fb.rows.map((r) => r.gross)), top.gross)) return "filtered breakdown differs from the category's row";
      }
      return null;
    });
  }

  await check("campminder enrollments match tables", async () => {
    if (!ref) return "no reference";
    const e = (ref as ReferenceTotals).enrollments;
    if (!e) return null; // nothing synced yet
    const [summary, breakdown] = await Promise.all([
      warehouse.enrollmentSummary({ season: e.season, filters: {} }, campminderCalendar()),
      warehouse.enrollmentBreakdown({ season: e.season, dimension: "session_group", filters: {} }),
    ]);
    if (summary.current.enrollments !== e.count) return "summary differs from table count";
    if (sum(breakdown.rows.map((r) => r.enrollments)) !== e.count) return "breakdown differs from table count";
    return null;
  });

  await check("report builder matches tables", async () => {
    if (!ref) return "no reference";
    const e = (ref as ReferenceTotals).enrollments;
    if (!e) return null;
    const r = await warehouse.runReport(
      reportSpecSchema.parse({ dataset: "enrollments", measure: "enrollments", filters: { season: [String(e.season)] } }),
      { overrides: {} },
    );
    const total = r.cells.find((c) => c.kind === "total")?.value ?? null;
    return total === e.count ? null : "report total differs from table count";
  });

  await check("school grouping runs", async () => {
    const spellings = await warehouse.schoolList();
    const map: SchoolMap = new Map(
      spellings.slice(0, 50).map((s, i) => [s.entered, { name: s.entered, type: i % 2 ? "public" : null, state: "DC", county: null }]),
    );
    map.set("(self-check: not a school)", null);
    await warehouse.runReport(reportSpecSchema.parse({ dataset: "camper_seasons", rows: ["school", "school_type"], column: "school_county", measure: "campers" }), { overrides: {} }, map);
    const e = (ref as ReferenceTotals | null)?.enrollments;
    if (e) {
      // The Camp dashboard's School breakdown covers every enrollment, grouped or not.
      const b = await warehouse.enrollmentBreakdown({ season: e.season, dimension: "school", filters: {} }, map);
      if (sum(b.rows.map((r) => r.enrollments)) !== e.count) return "school breakdown differs from table count";
    }
    return null;
  });

  await check("parent occupations run", async () => {
    await warehouse.runReport(reportSpecSchema.parse({ dataset: "enrollments", rows: ["parent_occupation"], column: "week", measure: "campers" }), { overrides: {} });
    const e = (ref as ReferenceTotals | null)?.enrollments;
    if (e) {
      // A family with parents in two fields counts under each, so never fewer than the table.
      const b = await warehouse.enrollmentBreakdown({ season: e.season, dimension: "occupation", filters: {} });
      if (sum(b.rows.map((r) => r.enrollments)) < e.count) return "occupation breakdown misses enrollments";
    }
    return null;
  });

  for (const starter of STARTER_REPORTS) {
    await check(`starter report runs: ${starter.name}`, async () => {
      await warehouse.runReport(starter.spec, { overrides: {} });
      return null;
    });
  }

  await check("settings assignments load", async () => {
    await warehouse.assignments();
    return null;
  });

  return { ok: checks.every((c) => c.ok), checks };
}
