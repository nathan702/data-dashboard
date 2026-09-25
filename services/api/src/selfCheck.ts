import { addDays, easternDate, RETAIL_SOURCES, type RetailSource } from "@dash/shared";
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
      const r = await warehouse.revenueSummary({ ...base, groupBy });
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
        warehouse.retailKpis(source, { start, end, compare: "none" }),
        warehouse.retailBreakdown(source, { start, end, dimension: "category", limit: 5000 }),
      ]);
      if (!ref) return "no reference";
      const expected = ref.retailGross[source];
      if (!close(kpis.current.gross, expected)) return "order totals differ from table total";
      if (!breakdown.truncated && !close(sum(breakdown.rows.map((r) => r.gross)), expected)) return "breakdown differs from table total";
      return null;
    });
  }

  await check("settings assignments load", async () => {
    await warehouse.assignments();
    return null;
  });

  return { ok: checks.every((c) => c.ok), checks };
}
