import { NONE_VALUE, REPORT_CELL_LIMIT, type ProgramFamilySettings, type ReportDataset, type ReportSpec } from "@dash/shared";
import { DIMENSION_SQL } from "./retailSql.js";

/**
 * Turns a report spec into one query. Only the fixed SQL fragments below are
 * ever interpolated; field and measure ids are checked against these maps
 * (and the shared schema), and every filter value is a query parameter.
 * Totals come from GROUPING SETS so distinct counts (campers, families) are
 * right at every level instead of summed.
 */

interface DatasetSql {
  /** CTEs this data set needs, then the table expression to read from (aliased src). */
  ctes: string[];
  from: string;
  fields: Record<string, string>;
  measures: Record<string, string>;
  /** Date column for dated data sets. */
  dateColumn?: string;
}

const ENROLLMENTS = (marts: string) => `\`${marts}.fct_campminder_enrollments\``;

/** Program families: Settings overrides (@pf), else the part of the name before " - " (see draftProgramFamily). */
const ENR_BASE = (marts: string) => `
  pfmap AS (SELECT program, family, branch FROM UNNEST(@pf)),
  enr_base AS (
    SELECT
      e.*,
      IF(pf.program IS NULL, IF(STRPOS(e.program, ' - ') > 0, TRIM(SUBSTR(e.program, 1, STRPOS(e.program, ' - ') - 1)), TRIM(e.program)), pf.family) AS program_family,
      IF(pf.program IS NULL, IF(STRPOS(e.program, ' - ') > 0, NULLIF(TRIM(SUBSTR(e.program, STRPOS(e.program, ' - ') + 3)), ''), NULL), pf.branch) AS program_branch
    FROM ${ENROLLMENTS(marts)} AS e
    LEFT JOIN pfmap AS pf ON pf.program = e.program
  )`;

/** Per camper (and season, business line …) attributes; the same names in every Campminder data set. */
const CAMPER_FIELDS = {
  season: "CAST(season AS STRING)",
  business_line: "business_line",
  camper: "SUBSTR(camper_hash, 1, 10)",
  years_at_camp: "CAST(years_as_camper AS STRING)",
  new_or_returning: "CASE WHEN years_as_camper = 1 THEN 'New' WHEN years_as_camper > 1 THEN 'Returning' END",
  age: "CAST(age_at_season AS STRING)",
  grade: "school_grade",
  gender: "gender",
  state: "home_state",
  zip: "home_zip",
};

const CAMPER_ROLLUP = `
      ANY_VALUE(family_hash) AS family_hash,
      MAX(years_as_camper) AS years_as_camper,
      MAX(age_at_season) AS age_at_season,
      ANY_VALUE(school_grade) AS school_grade,
      ANY_VALUE(gender) AS gender,
      ANY_VALUE(home_state) AS home_state,
      ANY_VALUE(home_zip) AS home_zip`;

function datasetSql(dataset: ReportDataset, marts: string, explodeWeeks: boolean): DatasetSql {
  switch (dataset) {
    case "enrollments":
      return {
        ctes: [ENR_BASE(marts)],
        // A multi-week session counts in each of its weeks, only when weeks are asked for.
        from: explodeWeeks
          ? "enr_base, UNNEST(IF(is_weekly, GENERATE_ARRAY(week_start, week_end), [CAST(NULL AS INT64)])) AS week"
          : "enr_base",
        fields: {
          ...CAMPER_FIELDS,
          session_group: "session_group",
          session: "session_name",
          program: "program",
          program_family: "program_family",
          program_branch: "program_branch",
          week: "CAST(week AS STRING)",
          status: "status",
        },
        measures: {
          enrollments: "COUNTIF(status_code = 'EN')",
          campers: "COUNT(DISTINCT IF(status_code = 'EN', camper_hash, NULL))",
          families: "COUNT(DISTINCT IF(status_code = 'EN', family_hash, NULL))",
          registrations: "COUNT(*)",
          cancelled: "COUNTIF(status_code = 'CN')",
          withdrawn: "COUNTIF(status_code = 'WD')",
          waitlisted: "COUNTIF(status_code = 'WL')",
        },
      };
    case "camper_seasons":
      return {
        ctes: [
          ENR_BASE(marts),
          `cs0 AS (
    SELECT
      season, business_line, camper_hash,${CAMPER_ROLLUP},
      COUNT(*) AS sessions,
      SUM(IF(is_weekly, week_end - week_start + 1, 0)) AS weeks,
      MIN(IF(is_weekly, week_start, NULL)) AS first_week,
      MAX(IF(is_weekly, week_end, NULL)) AS last_week,
      COUNT(DISTINCT program) AS programs
    FROM enr_base
    WHERE status_code = 'EN'
    GROUP BY season, business_line, camper_hash
  )`,
          `camper_seasons AS (
    SELECT
      a.*,
      -- Unknown for the newest season: its next season hasn't happened.
      CASE WHEN a.season >= (SELECT MAX(season) FROM cs0) THEN NULL ELSE b.camper_hash IS NOT NULL END AS returned
    FROM cs0 AS a
    LEFT JOIN cs0 AS b ON b.camper_hash = a.camper_hash AND b.business_line = a.business_line AND b.season = a.season + 1
  )`,
        ],
        from: "camper_seasons",
        fields: {
          ...CAMPER_FIELDS,
          sessions: "CAST(sessions AS STRING)",
          weeks: "CAST(weeks AS STRING)",
          first_week: "CAST(first_week AS STRING)",
          last_week: "CAST(last_week AS STRING)",
          programs: "CAST(programs AS STRING)",
          returned: "CASE returned WHEN TRUE THEN 'Returned' WHEN FALSE THEN 'Didn''t return' ELSE 'Not known yet' END",
        },
        measures: {
          campers: "COUNT(DISTINCT camper_hash)",
          avg_sessions: "AVG(sessions)",
          avg_weeks: "AVG(weeks)",
          return_rate: "AVG(IF(returned IS NULL, NULL, IF(returned, 1, 0)))",
          sessions_total: "SUM(sessions)",
          families: "COUNT(DISTINCT family_hash)",
        },
      };
    case "program_families":
      return {
        ctes: [
          ENR_BASE(marts),
          `program_families AS (
    SELECT
      season, business_line, camper_hash, program_family,${CAMPER_ROLLUP},
      COUNT(DISTINCT COALESCE(program_branch, '(base program)')) AS branches,
      STRING_AGG(DISTINCT COALESCE(program_branch, '(base program)'), ' + ' ORDER BY COALESCE(program_branch, '(base program)')) AS branch_combination
    FROM enr_base
    WHERE status_code = 'EN' AND program_family IS NOT NULL
    GROUP BY season, business_line, camper_hash, program_family
  )`,
        ],
        from: "program_families",
        fields: {
          ...CAMPER_FIELDS,
          program_family: "program_family",
          branches: "CAST(branches AS STRING)",
          branch_combination: "branch_combination",
        },
        measures: {
          campers: "COUNT(DISTINCT camper_hash)",
          avg_branches: "AVG(branches)",
        },
      };
    case "revenue":
      return {
        ctes: [],
        from: `\`${marts}.fct_revenue_daily\``,
        dateColumn: "revenue_date",
        fields: {
          business_line: "business_line",
          source: "source",
          year: "CAST(EXTRACT(YEAR FROM revenue_date) AS STRING)",
          month: "FORMAT_DATE('%Y-%m', revenue_date)",
          weekday: "FORMAT_DATE('%A', revenue_date)",
          date: "CAST(revenue_date AS STRING)",
          date_basis: "CASE date_basis WHEN 'service' THEN 'Program / service date' WHEN 'booked' THEN 'Date booked' WHEN 'collected' THEN 'Date paid' END",
        },
        measures: {
          net: "SUM(gross - discounts - refunds)",
          gross: "SUM(gross)",
          net_after_fees: "SUM(gross - discounts - refunds - fees)",
          transactions: "SUM(transactions)",
        },
      };
    case "store_sales":
      return {
        ctes: [],
        from: `\`${marts}.fct_retail_line_items\``,
        dateColumn: "sale_date",
        fields: {
          source: "source",
          business_line: "business_line",
          location: DIMENSION_SQL.location.key,
          channel: DIMENSION_SQL.channel.key,
          category: DIMENSION_SQL.category.key,
          item: DIMENSION_SQL.item.key,
          variant: DIMENSION_SQL.variant.key,
          year: "CAST(EXTRACT(YEAR FROM sale_date) AS STRING)",
          month: "FORMAT_DATE('%Y-%m', sale_date)",
          weekday: "FORMAT_DATE('%A', sale_date)",
          date: "CAST(sale_date AS STRING)",
        },
        measures: {
          net: "SUM(gross - discounts)",
          gross: "SUM(gross)",
          discounts: "SUM(discounts)",
          units: "SUM(quantity)",
          orders: "COUNT(DISTINCT order_id)",
        },
      };
  }
}

const CAMPMINDER: ReportDataset[] = ["enrollments", "camper_seasons", "program_families"];

/** Revenue counts by program/service date unless the report says otherwise. */
export function effectiveFilters(spec: ReportSpec): Record<string, string[]> {
  const filters = Object.fromEntries(Object.entries(spec.filters).filter(([, v]) => v.length > 0));
  if (spec.dataset === "revenue" && !filters.date_basis && !spec.rows.includes("date_basis") && spec.column !== "date_basis") {
    filters.date_basis = ["Program / service date"];
  }
  return filters;
}

export function compileReport(spec: ReportSpec, marts: string, families: ProgramFamilySettings) {
  const filters = effectiveFilters(spec);
  const usesWeek = spec.rows.includes("week") || spec.column === "week" || "week" in filters;
  const ds = datasetSql(spec.dataset, marts, usesWeek);
  const field = (id: string) => {
    const sql = ds.fields[id];
    if (!sql) throw new Error(`Unknown field ${id}`);
    return `COALESCE(${sql}, '${NONE_VALUE}')`;
  };
  const measure = ds.measures[spec.measure];
  if (!measure) throw new Error(`Unknown measure ${spec.measure}`);

  const params: Record<string, unknown> = {};
  const types: Record<string, unknown> = {};
  const where: string[] = ["TRUE"];
  Object.entries(filters).forEach(([id, values], i) => {
    params[`f${i}`] = values;
    types[`f${i}`] = ["STRING"];
    where.push(`${field(id)} IN UNNEST(@f${i})`);
  });
  if (ds.dateColumn) {
    params.start = spec.start;
    params.end = spec.end;
    types.start = "DATE";
    types.end = "DATE";
    where.push(`${ds.dateColumn} BETWEEN @start AND @end`);
  }
  if (CAMPMINDER.includes(spec.dataset)) {
    params.pf = Object.entries(families.overrides).map(([program, v]) => ({ program, family: v.family, branch: v.branch }));
    types.pf = [{ program: "STRING", family: "STRING", branch: "STRING" }];
  }

  const rowAliases = spec.rows.map((_, i) => `r${i}`);
  const dims = [...spec.rows.map((id, i) => `${field(id)} AS r${i}`), ...(spec.column ? [`${field(spec.column)} AS c`] : [])];
  const cellKeys = [...rowAliases, ...(spec.column ? ["c"] : [])];
  const sets: string[][] = [cellKeys];
  if (rowAliases.length && spec.column) sets.push(rowAliases, ["c"]);
  if (cellKeys.length) sets.push([]);
  const groupBy = cellKeys.length ? `GROUP BY GROUPING SETS (${sets.map((s) => `(${s.join(", ")})`).join(", ")})` : "";
  const gRow = rowAliases.length ? "GROUPING(r0)" : "0";
  const gCol = spec.column ? "GROUPING(c)" : "0";

  const sql = `
    WITH ${[...ds.ctes, `src AS (SELECT * FROM ${ds.from})`].join(",\n  ")},
    picked AS (
      SELECT src.*${dims.length ? `, ${dims.join(", ")}` : ""}
      FROM src
      WHERE ${where.join("\n        AND ")}
    )
    SELECT
      ${[...rowAliases, ...(spec.column ? ["c"] : [])].join(", ")}${cellKeys.length ? "," : ""}
      ${measure} AS value,
      ${gRow} AS g_row,
      ${gCol} AS g_col
    FROM picked
    ${groupBy}
    ORDER BY g_row + g_col DESC, value DESC
    LIMIT ${REPORT_CELL_LIMIT * 4 + 1}`;
  return { sql, params, types };
}

export type ReportRow = Record<string, unknown> & { value: unknown; g_row: number; g_col: number };
