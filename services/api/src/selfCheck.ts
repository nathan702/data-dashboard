import {
  addDays,
  BUSINESS_LINES,
  CALENDAR_YEAR,
  campminderCalendar,
  DEFAULT_SEASON_SETTINGS,
  easternDate,
  RETAIL_SOURCES,
  isIsoDate,
  reportSpecSchema,
  resolveReturning,
  STARTER_REPORTS,
  type RetailSource,
} from "@dash/shared";
import { runReturningReport } from "./returningReport.js";
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
  /** SUM(gross - discounts - refunds) of fct_revenue_daily, service basis, assigned lines only, over the range. */
  serviceNet: number;
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

  // Dates reach the queries as text: a date that arrives empty puts every sign-up in week 0 (a flat pace
  // line), drops last season's comparison to nothing, or empties dated reports.
  await check("dates reach the queries", async () => {
    if (!ref) return "no reference";
    const r = ref as ReferenceTotals;
    const byWeek = await warehouse.runReport(
      reportSpecSchema.parse({ dataset: "revenue", measure: "gross", filters: { date_basis: ["Date booked"] }, start, end }),
      { overrides: {} },
    );
    if (!close(byWeek.cells.find((c) => c.kind === "total")?.value ?? 0, r.revenueGross)) return "dated report differs from table total";
    const seasonView = await warehouse.revenueSummary({ ...base, granularity: "season", groupBy: "business_line" }, CALENDAR_YEAR);
    if (!close(sum(seasonView.series.map((p) => p.value)), r.revenueGross)) return "revenue by season differs from table total";
    const e = r.enrollments;
    if (e && e.count > 0) {
      const s = await warehouse.enrollmentSummary({ season: e.season, filters: {} }, campminderCalendar());
      const values = new Set(s.pace.map((p) => p.current).filter((v) => v !== null));
      if (values.size <= 1) return "sign-up pace is flat (every sign-up in one week)";
      const prev = s.pace.at(-1)?.previous ?? 0;
      if (prev > 0 && s.comparison && s.comparison.enrollments === 0) return "last season's comparison is empty";
    }
    return null;
  });

  // Targets read their own table (revenue by program date and booking date): this season so far
  // must equal the service-date revenue over the same dates. Also runs the guests, participants
  // and Campminder parts of the query for every line.
  await check("targets match tables", async () => {
    if (!ref) return "no reference";
    const r = ref as ReferenceTotals;
    const before = addDays(start, -1);
    let total = 0;
    for (const businessLine of BUSINESS_LINES) {
      const a = await warehouse.targetActuals({
        businessLine,
        season: Number(end.slice(0, 4)),
        current: { start, end },
        previous: { start: addDays(start, -365), end: before },
        cutoff: addDays(end, -365),
        participantProps: [],
      });
      total += a.revenue.current;
      if (a.revenue.previousAtSamePoint > a.revenue.previousFinal + TOLERANCE) return "last season at the same point exceeds its total";
    }
    return close(total, r.serviceNet) ? null : "targets revenue differs from table total";
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

  await check("camper follow-up measures run", async () => {
    // Sessions in the chosen groups, same-group returns, other lines, cancellations, sign-up timing and an exclusion.
    for (const measure of ["avg_sessions_matching", "return_rate_same_group", "cancel_rate"]) {
      await warehouse.runReport(
        reportSpecSchema.parse({
          dataset: "camper_seasons",
          rows: ["session_group", "also_business_line"],
          column: "season",
          measure,
          filters: { week: ["1", "2"] },
          exclude: { program: ["(self-check)"] },
          change: "percent",
        }),
        { overrides: {} },
      );
    }
    await warehouse.runReport(reportSpecSchema.parse({ dataset: "enrollments", rows: ["signup_month", "weeks_before_session"], measure: "enrollments" }), { overrides: {} });
    return null;
  });

  await check("registration pace runs", async () => {
    const { registration } = DEFAULT_SEASON_SETTINGS;
    await warehouse.registrationPace({ businessLine: "camp", filters: { week: ["1"] } }, registration, new Map());
    // Sign-ups spread over many days; all on one day means the opening dates didn't reach the query.
    const { rows } = await warehouse.registrationPace({ businessLine: "camp", filters: {} }, registration, new Map());
    const seasons = new Map<number, Set<number>>();
    for (const r of rows) seasons.set(r.season, (seasons.get(r.season) ?? new Set()).add(r.day));
    const flat = [...seasons].filter(([, days]) => days.size === 1).map(([s]) => s);
    return rows.length && flat.length === seasons.size ? `every season's sign-ups fall on one day (${flat.join(", ")})` : null;
  });

  // Returning families: one row per household and season, the same number as a plain count of last season's households.
  await check("returning families match tables", async () => {
    const { registration } = DEFAULT_SEASON_SETTINGS;
    const [rows, counts] = await Promise.all([
      warehouse.returningFamilies(registration.locations, []),
      warehouse.returningFamilyCounts(Object.keys(registration.locations)),
    ]);
    for (const c of counts) {
      const n = rows.filter((r) => r.season === c.season).length;
      if (n !== c.families) return `season ${c.season}: ${n} families, table count ${c.families}`;
    }
    if (rows.length !== sum(counts.map((c) => c.families))) return "families in seasons the table count doesn't have";
    if (rows.some((r) => r.campers.length === 0)) return "a family without campers";
    // Dates arrive as text: an odd date, or none reaching us at all, would put every family off the chart. (A few
    // enrollments have no application date in Campminder; those families count as re-enrolled but aren't on the chart.)
    if (rows.some((r) => r.enrolledOn !== null && !isIsoDate(r.enrolledOn))) return "a re-enrolled family's sign-up date isn't a date";
    const back = rows.filter((r) => r.enrolled);
    if (back.length > 0 && back.every((r) => r.enrolledOn === null)) return "no re-enrolled family has a sign-up date";
    resolveReturning(rows, registration);
    return null;
  });

  // Net tuition per camper: what's given to campers plus what isn't counted per camper adds back up to the
  // season's net tuition, and the report builder's total matches the card's.
  await check("revenue per camper adds up", async () => {
    const e = (ref as ReferenceTotals | null)?.enrollments;
    if (!e) return null;
    // The newest season with financials (the daily Financial tab can be just starting).
    let season = e.season;
    let fin = await warehouse.campminderFinance({ season, filters: {} });
    if (fin.charges === 0) fin = await warehouse.campminderFinance({ season: --season, filters: {} });
    if (fin.charges === 0) return null;
    const per = await warehouse.camperTuition({ season, filters: {} }, { prevCutoff: "9999-12-31", extras: [] });
    const c = per.current;
    if (!close(c.tuition + c.extras + c.notPerCamper, fin.netTuition)) return `season ${season}: per camper and not counted don't add up to net tuition`;
    if (c.campers > 0 && c.tuition === 0) return `season ${season}: campers but no tuition given to them`;
    // The report rounds each camper to the cent: allow that much.
    const near = (a: number, b: number, campers: number) => Math.abs(a - b) <= TOLERANCE + 0.005 * campers;
    const reportTotal = async (line?: string) =>
      (
        await warehouse.runReport(
          reportSpecSchema.parse({ dataset: "camper_seasons", rows: [], measure: "net_tuition", filters: { season: [String(season)], ...(line ? { business_line: [line] } : {}) } }),
          { overrides: {} },
          new Map(),
          [],
        )
      ).cells[0]?.value ?? 0;
    const camp = (await warehouse.camperTuition({ season, businessLine: "camp", filters: {} }, { prevCutoff: "9999-12-31", extras: [] })).current;
    if (!near(await reportTotal("camp"), camp.tuition, camp.campers)) return `season ${season}: Camp's report builder net tuition differs from the card's`;
    if (!near(await reportTotal(), c.tuition, c.campers)) return `season ${season}: all lines' report builder net tuition differs from the card's (Camp alone matches)`;
    // With filters, lines are matched to camper-sessions; last season as of a date.
    await warehouse.camperTuition({ season, businessLine: "camp", filters: { week: ["1"] } }, { prevCutoff: `${season - 1}-12-31`, extras: ["Lunch"] }, new Map());
    return null;
  });

  // New families: the tile, the filter and the report agree, and new + returning = all families.
  await check("new families add up", async () => {
    const e = (ref as ReferenceTotals | null)?.enrollments;
    if (!e) return null;
    const cal = campminderCalendar();
    const sum = async (f: Record<string, string[]>) => (await warehouse.enrollmentSummary({ season: e.season, businessLine: "camp", filters: f }, cal, new Map())).current;
    const [all, fresh, back] = await Promise.all([sum({}), sum({ new_family: ["New family"] }), sum({ new_family: ["Returning family"] })]);
    if (fresh.families !== all.newFamilies) return "the New families tile differs from filtering to new families";
    if (fresh.families + back.families !== all.families) return "new and returning families don't add up to all families";
    await warehouse.enrollmentBreakdown({ season: e.season, businessLine: "camp", dimension: "heard", filters: { new_family: ["New family"] } }, new Map());
    await warehouse.enrollmentBreakdown({ season: e.season, businessLine: "camp", dimension: "came_through", filters: {} }, new Map());
    return null;
  });

  await check("HubSpot deals run", async () => {
    await warehouse.hubspotDeals("education");
    await warehouse.hubspotProperties();
    await warehouse.hubspotExtent("education");
    await warehouse.hubspotPrograms({
      businessLine: "education",
      from: "2025-01-01",
      to: "2026-12-31",
      currentStart: "2026-01-01",
      cutoff: "2025-06-01",
      roles: { participants: ["x", "y"], chaperones: [], programType: ["x"], food: ["x"], transportation: ["x"] },
    });
    return null;
  });

  await check("FareHarbor bookings by day run", async () => {
    await warehouse.fareharborExtent("haunted_forest");
    const rows = await warehouse.fareharborDays({ businessLine: "haunted_forest", from: "2025-09-01", to: "2025-11-30", cutoff: "2025-10-01", nightly: true });
    await warehouse.fareharborDays({ businessLine: "river_school", from: "2025-01-01", to: "2025-12-31", cutoff: "2025-06-01", nightly: false });
    // Same-point figures can't exceed the final ones; if they do, the cutoff didn't reach the query.
    const over = rows.filter((r) => r.guestsAtSamePoint > r.guests);
    return over.length ? `${over.length} rows sold more by the same point than in all` : null;
  });

  await check("family reporting runs", async () => {
    await warehouse.runReport(
      reportSpecSchema.parse({ dataset: "families", rows: ["campers_in_family", "change_vs_last"], column: "season", measure: "pct_together" }),
      { overrides: {} },
    );
    await warehouse.runReport(reportSpecSchema.parse({ dataset: "camper_seasons", rows: ["campers_in_family"], measure: "campers" }), { overrides: {} });
    return null;
  });

  await check("campminder financials run", async () => {
    await warehouse.runReport(
      reportSpecSchema.parse({ dataset: "campminder_finance", rows: ["business_line", "type"], column: "season", measure: "balance_owed" }),
      { overrides: {} },
    );
    const e = (ref as ReferenceTotals | null)?.enrollments;
    if (e) {
      await warehouse.campminderFinance({ season: e.season, filters: {} });
      // With a drill-down filter, lines are matched to enrollments.
      await warehouse.campminderFinance({ season: e.season, filters: { week: ["1"], school: ["(self-check)"] } }, new Map());
      const items = (await warehouse.campLineItems()).map((i) => i.item);
      await warehouse.campminderExtras({ season: e.season, businessLine: "camp" }, `${e.season - 1}-12-31`, items.slice(0, 5));
    }
    await warehouse.runReport(
      reportSpecSchema.parse({ dataset: "campminder_finance", rows: ["item_group", "extra_session_group"], column: "item_week", measure: "items_sold" }),
      { overrides: {} },
    );
    return null;
  });

  for (const starter of STARTER_REPORTS) {
    await check(`starter report runs: ${starter.name}`, async () => {
      if (starter.spec.dataset === "returning_families") {
        runReturningReport(starter.spec, resolveReturning(await warehouse.returningFamilies(DEFAULT_SEASON_SETTINGS.registration.locations, []), DEFAULT_SEASON_SETTINGS.registration));
      } else await warehouse.runReport(starter.spec, { overrides: {} });
      return null;
    });
  }

  await check("settings assignments load", async () => {
    await warehouse.assignments();
    return null;
  });

  return { ok: checks.every((c) => c.ok), checks };
}
