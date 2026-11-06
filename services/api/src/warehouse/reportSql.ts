import { NONE_VALUE, REPORT_CELL_LIMIT, type ProgramFamilySettings, type ReportDataset, type ReportSpec, type SchoolForReports } from "@dash/shared";
import { DIMENSION_SQL } from "./retailSql.js";

/** School as entered → its school for reports (null: no school); see resolveSchoolSpellings. */
export type SchoolMap = Map<string, SchoolForReports | null>;

const SCHOOL_TYPE_LABEL = { public: "Public", private: "Private", other: "Other" } as const;

/** @schools: each spelling's school, type, state and county, as one array parameter. */
export function schoolParams(schools: SchoolMap) {
  return {
    params: {
      schools: [...schools].map(([entered, s]) => ({
        entered,
        school: s?.name ?? null,
        school_type: s?.type ? SCHOOL_TYPE_LABEL[s.type] : null,
        school_state: s?.state ?? null,
        school_county: s?.county ?? null,
      })),
    },
    types: { schools: [{ entered: "STRING", school: "STRING", school_type: "STRING", school_state: "STRING", school_county: "STRING" }] },
  };
}

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
  /**
   * Fields with several values per record (field id → array column): a camper
   * attended several sessions; a family has parents in several fields. A
   * record counts under each of its values when the field is a row or column;
   * a filter keeps records with any of the chosen values, counted once.
   */
  multi?: Record<string, string>;
  /** Columns worked out per report (they depend on which fields are shown or filtered), for the measures to use. */
  computed?(ctx: ReportContext): string[];
  /** Date column for dated data sets. */
  dateColumn?: string;
}

/** What a report shows and filters on, for computed columns. */
interface ReportContext {
  /** Multi-valued fields split into rows or columns (their value is mv_<field>). */
  exploded: string[];
  /** Filtered field → its values' parameter (@f0…). */
  filterParam: Record<string, string>;
}

/** A program's family: Settings overrides (pfmap, from @pf), else the part of the name before " - ". */
const programFamilySql = (program: string, pf: string) =>
  `IF(${pf}.program IS NULL, IF(STRPOS(${program}, ' - ') > 0, TRIM(SUBSTR(${program}, 1, STRPOS(${program}, ' - ') - 1)), TRIM(${program})), ${pf}.family)`;

/** Enrolled campers in the household that season and business line, as "1 camper" … "4+ campers". */
export const FAMILY_BUCKET = (n: string) =>
  `CASE WHEN ${n} IS NULL OR ${n} = 0 THEN NULL WHEN ${n} = 1 THEN '1 camper' WHEN ${n} >= 4 THEN '4+ campers' ELSE CONCAT(CAST(${n} AS STRING), ' campers') END`;

/** Enrolled campers per household, season and business line, to join to an enrollments table (as fc, on those three). */
export const familyCampersSql = (table: string) => `(
      SELECT season, business_line, family_hash, COUNT(DISTINCT IF(status_code = 'EN', camper_hash, NULL)) AS family_campers
      FROM ${table}
      WHERE family_hash IS NOT NULL
      GROUP BY 1, 2, 3
    )`;

const ENROLLMENTS = (marts: string) => `\`${marts}.fct_campminder_enrollments\``;

/**
 * Program families: Settings overrides (@pf), else the part of the name before " - " (see draftProgramFamily).
 * Schools: every spelling's school (@schools, from resolveSchoolSpellings); a spelling newer than that list shows as entered.
 */
const ENR_BASE = (marts: string) => `
  pfmap AS (SELECT program, family, branch FROM UNNEST(@pf)),
  schoolmap AS (SELECT * FROM UNNEST(@schools)),
  enr_base AS (
    SELECT
      e.*,
      IF(sm.entered IS NULL, e.school, sm.school) AS school_group,
      sm.school_type,
      sm.school_state,
      sm.school_county,
      fc.family_campers,
      ${programFamilySql("e.program", "pf")} AS program_family,
      IF(pf.program IS NULL, IF(STRPOS(e.program, ' - ') > 0, NULLIF(TRIM(SUBSTR(e.program, STRPOS(e.program, ' - ') + 3)), ''), NULL), pf.branch) AS program_branch,
      IF(e.is_weekly, ARRAY(SELECT CAST(w AS STRING) FROM UNNEST(GENERATE_ARRAY(e.week_start, e.week_end)) AS w), CAST([] AS ARRAY<STRING>)) AS week_list
    FROM ${ENROLLMENTS(marts)} AS e
    LEFT JOIN pfmap AS pf ON pf.program = e.program
    LEFT JOIN schoolmap AS sm ON sm.entered = e.school
    LEFT JOIN ${familyCampersSql(ENROLLMENTS(marts))} AS fc
      ON fc.season = e.season AND fc.business_line = e.business_line AND fc.family_hash = e.family_hash
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
  school: "school_group",
  school_as_entered: "school",
  school_type: "school_type",
  school_state: "school_state",
  school_county: "school_county",
  campers_in_family: FAMILY_BUCKET("family_campers"),
  signup_month: "FORMAT_DATE('%Y-%m', application_date)",
  signup_week: "CAST(DATE_TRUNC(application_date, WEEK(MONDAY)) AS STRING)",
  gender: "gender",
  state: "home_state",
  zip: "home_zip",
};

const CAMPER_ROLLUP = `
      ANY_VALUE(family_hash) AS family_hash,
      MAX(years_as_camper) AS years_as_camper,
      MAX(age_at_season) AS age_at_season,
      ANY_VALUE(school_grade) AS school_grade,
      ANY_VALUE(school) AS school,
      ANY_VALUE(school_group) AS school_group,
      ANY_VALUE(school_type) AS school_type,
      ANY_VALUE(school_state) AS school_state,
      ANY_VALUE(school_county) AS school_county,
      ANY_VALUE(parent_occupations) AS parent_occupations,
      ANY_VALUE(gender) AS gender,
      ANY_VALUE(home_state) AS home_state,
      ANY_VALUE(home_zip) AS home_zip,
      MIN(application_date) AS application_date,
      MAX(family_campers) AS family_campers`;

/** Multi-valued fields of every Campminder data set. */
const CAMPER_MULTI = { parent_occupation: "parent_occupations" };

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
          weeks_before_session: "CAST(DIV(DATE_DIFF(session_start, application_date, DAY), 7) AS STRING)",
        },
        multi: CAMPER_MULTI,
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
      COUNT(DISTINCT program) AS programs,
      ARRAY_AGG(DISTINCT session_group IGNORE NULLS) AS attended_session_groups,
      ARRAY_AGG(DISTINCT session_name IGNORE NULLS) AS attended_sessions,
      ARRAY_AGG(DISTINCT program IGNORE NULLS) AS attended_programs,
      ARRAY_AGG(DISTINCT program_family IGNORE NULLS) AS attended_program_families,
      ARRAY_CONCAT_AGG(week_list) AS attended_week_list,
      -- Each session, for "sessions in the chosen groups".
      ARRAY_AGG(STRUCT(session_group, session_name AS session, program, program_family, week_list AS weeks)) AS session_list
    FROM enr_base
    WHERE status_code = 'EN'
    GROUP BY season, business_line, camper_hash
  )`,
          `cs_cancels AS (
    SELECT season, business_line, camper_hash, COUNTIF(status_code IN ('CN', 'WD')) AS cancelled_sessions
    FROM enr_base
    GROUP BY season, business_line, camper_hash
  )`,
          `cs_lines AS (
    SELECT season, camper_hash, ARRAY_AGG(DISTINCT business_line) AS lines
    FROM cs0
    GROUP BY season, camper_hash
  )`,
          `camper_seasons AS (
    SELECT
      a.*,
      ARRAY(SELECT DISTINCT w FROM UNNEST(a.attended_week_list) AS w) AS attended_weeks,
      ARRAY(SELECT l FROM UNNEST(cl.lines) AS l WHERE l != a.business_line) AS other_business_lines,
      COALESCE(cc.cancelled_sessions, 0) AS cancelled_sessions,
      -- Unknown for the newest season: its next season hasn't happened.
      CASE WHEN a.season >= (SELECT MAX(season) FROM cs0) THEN NULL ELSE b.camper_hash IS NOT NULL END AS returned,
      -- This season's session groups the camper was in again next season.
      CASE
        WHEN a.season >= (SELECT MAX(season) FROM cs0) THEN NULL
        ELSE ARRAY(SELECT g FROM UNNEST(a.attended_session_groups) AS g WHERE g IN UNNEST(IFNULL(b.attended_session_groups, [])))
      END AS returned_groups
    FROM cs0 AS a
    LEFT JOIN cs0 AS b ON b.camper_hash = a.camper_hash AND b.business_line = a.business_line AND b.season = a.season + 1
    LEFT JOIN cs_lines AS cl ON cl.season = a.season AND cl.camper_hash = a.camper_hash
    LEFT JOIN cs_cancels AS cc ON cc.season = a.season AND cc.business_line = a.business_line AND cc.camper_hash = a.camper_hash
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
          cancellations: "IF(cancelled_sessions > 0, 'Cancelled or withdrew a session', 'No cancellations')",
        },
        multi: {
          ...CAMPER_MULTI,
          session_group: "attended_session_groups",
          session: "attended_sessions",
          program: "attended_programs",
          program_family: "attended_program_families",
          week: "attended_weeks",
          also_business_line: "other_business_lines",
        },
        computed: campersComputed,
        measures: {
          campers: "COUNT(DISTINCT camper_hash)",
          avg_sessions: "AVG(sessions)",
          avg_weeks: "AVG(weeks)",
          return_rate: "AVG(IF(returned IS NULL, NULL, IF(returned, 1, 0)))",
          sessions_total: "SUM(sessions)",
          families: "COUNT(DISTINCT family_hash)",
          return_rate_same_group: "AVG(IF(returned_same_group IS NULL, NULL, IF(returned_same_group, 1, 0)))",
          avg_sessions_matching: "AVG(matching_sessions)",
          sessions_matching: "SUM(matching_sessions)",
          cancel_rate: "AVG(IF(cancelled_sessions > 0, 1, 0))",
          cancelled_sessions: "SUM(cancelled_sessions)",
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
        multi: CAMPER_MULTI,
        measures: {
          campers: "COUNT(DISTINCT camper_hash)",
          avg_branches: "AVG(branches)",
        },
      };
    case "families":
      return {
        ctes: [
          ENR_BASE(marts),
          `fam0 AS (
    SELECT
      season, business_line, family_hash,
      COUNT(DISTINCT camper_hash) AS campers,
      ANY_VALUE(home_state) AS home_state,
      ANY_VALUE(home_zip) AS home_zip,
      ANY_VALUE(parent_occupations) AS parent_occupations,
      ARRAY_AGG(DISTINCT session_group IGNORE NULLS) AS attended_session_groups,
      ARRAY_CONCAT_AGG(week_list) AS attended_week_list
    FROM enr_base
    WHERE status_code = 'EN' AND family_hash IS NOT NULL
    GROUP BY season, business_line, family_hash
  )`,
          `fam_weeks AS (
    -- Weeks with two or more of the family's campers at camp.
    SELECT season, business_line, family_hash, COUNT(*) AS weeks_together
    FROM (
      SELECT season, business_line, family_hash, w
      FROM enr_base, UNNEST(week_list) AS w
      WHERE status_code = 'EN' AND family_hash IS NOT NULL
      GROUP BY 1, 2, 3, 4
      HAVING COUNT(DISTINCT camper_hash) >= 2
    )
    GROUP BY 1, 2, 3
  )`,
          `families AS (
    SELECT
      a.*,
      ARRAY(SELECT DISTINCT w FROM UNNEST(a.attended_week_list) AS w) AS attended_weeks,
      COALESCE(fw.weeks_together, 0) AS weeks_together,
      p.campers AS last_season_campers,
      a.season <= (SELECT MIN(season) FROM fam0) AS first_season_of_data,
      -- Unknown for the newest season: its next season hasn't happened.
      CASE WHEN a.season >= (SELECT MAX(season) FROM fam0) THEN NULL ELSE nx.family_hash IS NOT NULL END AS returned
    FROM fam0 AS a
    LEFT JOIN fam_weeks AS fw ON fw.season = a.season AND fw.business_line = a.business_line AND fw.family_hash = a.family_hash
    LEFT JOIN fam0 AS p ON p.family_hash = a.family_hash AND p.business_line = a.business_line AND p.season = a.season - 1
    LEFT JOIN fam0 AS nx ON nx.family_hash = a.family_hash AND nx.business_line = a.business_line AND nx.season = a.season + 1
  )`,
        ],
        from: "families",
        fields: {
          season: "CAST(season AS STRING)",
          business_line: "business_line",
          household: "SUBSTR(family_hash, 1, 10)",
          campers_in_family: FAMILY_BUCKET("campers"),
          siblings: "IF(campers >= 2, 'Siblings at camp', 'One camper')",
          weeks_together: "CAST(weeks_together AS STRING)",
          last_season_campers: "IF(first_season_of_data, NULL, CAST(COALESCE(last_season_campers, 0) AS STRING))",
          change_vs_last:
            "CASE WHEN first_season_of_data THEN NULL WHEN last_season_campers IS NULL THEN 'New family' WHEN campers > last_season_campers THEN 'More campers' WHEN campers = last_season_campers THEN 'Same number' ELSE 'Fewer campers' END",
          returned: "CASE returned WHEN TRUE THEN 'Returned' WHEN FALSE THEN 'Didn''t return' ELSE 'Not known yet' END",
          state: "home_state",
          zip: "home_zip",
        },
        multi: {
          parent_occupation: "parent_occupations",
          session_group: "attended_session_groups",
          week: "attended_weeks",
        },
        measures: {
          families: "COUNT(DISTINCT CONCAT(CAST(season AS STRING), business_line, family_hash))",
          campers: "SUM(campers)",
          avg_campers: "AVG(campers)",
          sibling_families: "COUNT(DISTINCT IF(campers >= 2, CONCAT(CAST(season AS STRING), business_line, family_hash), NULL))",
          pct_sibling_families: "AVG(IF(campers >= 2, 1, 0))",
          campers_in_sibling_families: "SUM(IF(campers >= 2, campers, 0))",
          weeks_together: "SUM(weeks_together)",
          pct_together: "AVG(IF(campers >= 2, IF(weeks_together > 0, 1, 0), NULL))",
          return_rate: "AVG(IF(returned IS NULL, NULL, IF(returned, 1, 0)))",
        },
      };
    case "campminder_finance":
      return {
        ctes: [
          `pfmap AS (SELECT program, family, branch FROM UNNEST(@pf))`,
          `fin_base AS (
    SELECT
      t.*,
      ${programFamilySql("t.program", "pf")} AS program_family,
      -- The household's balance in this business line and season (all its lines, whatever a report filters).
      SUM(t.amount) OVER (PARTITION BY t.family_hash, t.season, t.business_line) AS household_balance
    FROM \`${marts}.fct_campminder_transactions\` AS t
    LEFT JOIN pfmap AS pf ON pf.program = t.program
  )`,
        ],
        from: "fin_base",
        fields: {
          season: "CAST(season AS STRING)",
          business_line: "business_line",
          type: "CASE type WHEN 'debit' THEN 'Charge' WHEN 'credit' THEN 'Discount or credit' WHEN 'payment' THEN 'Payment' WHEN 'refund' THEN 'Refund' ELSE 'Transfer' END",
          category: "category",
          session_group: "session_group",
          session: "session_name",
          program: "program",
          program_family: "program_family",
          method: "method",
          post_month: "FORMAT_DATE('%Y-%m', post_date)",
          service_month: "FORMAT_DATE('%Y-%m', service_start)",
          household: "SUBSTR(family_hash, 1, 10)",
          assigned_by:
            "CASE assigned_by WHEN 'session' THEN 'Session group' WHEN 'category' THEN 'Financial category' WHEN 'household' THEN 'Household''s main line' ELSE 'Not assigned' END",
        },
        measures: {
          net_tuition: "SUM(IF(type IN ('debit', 'credit'), amount, 0))",
          charges: "SUM(IF(type = 'debit', amount, 0))",
          discounts: "SUM(IF(type = 'credit', -amount, 0))",
          net_collected: "SUM(IF(type = 'payment', -amount, IF(type = 'refund', -amount, 0)))",
          payments: "SUM(IF(type = 'payment', -amount, 0))",
          refunds: "SUM(IF(type = 'refund', amount, 0))",
          balance: "SUM(amount)",
          balance_owed: "SUM(IF(household_balance > 0.005, amount, 0))",
          households_owing: "COUNT(DISTINCT IF(household_balance > 0.005, family_hash, NULL))",
          households: "COUNT(DISTINCT family_hash)",
          transactions: "COUNT(DISTINCT transaction_id)",
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

/** Session fields a camper's sessions can be matched on: field id → that field in session_list. */
const SESSION_MATCH: Record<string, string> = { session_group: "session_group", session: "session", program: "program", program_family: "program_family" };

/**
 * Campers by season: which of a camper's sessions fall in the session group,
 * session, program, family or week shown (as a row or column) or filtered to,
 * and whether they came back to the same session group.
 */
function campersComputed({ exploded, filterParam }: ReportContext): string[] {
  const conds = ["TRUE"];
  for (const id of [...Object.keys(SESSION_MATCH), "week"]) {
    const inSession = (v: string) => (id === "week" ? `${v} IN UNNEST(x.weeks)` : `x.${SESSION_MATCH[id]} = ${v}`);
    if (exploded.includes(id)) conds.push(inSession(`mv_${id}`));
    else if (filterParam[id]) {
      conds.push(
        id === "week"
          ? `EXISTS (SELECT 1 FROM UNNEST(x.weeks) AS w WHERE w IN UNNEST(@${filterParam[id]}))`
          : `COALESCE(x.${SESSION_MATCH[id]}, '${NONE_VALUE}') IN UNNEST(@${filterParam[id]})`,
      );
    }
  }
  const sameGroup = exploded.includes("session_group")
    ? "mv_session_group IN UNNEST(returned_groups)"
    : filterParam.session_group
      ? `EXISTS (SELECT 1 FROM UNNEST(returned_groups) AS g WHERE g IN UNNEST(@${filterParam.session_group}))`
      : "ARRAY_LENGTH(returned_groups) > 0";
  return [
    `(SELECT COUNT(*) FROM UNNEST(session_list) AS x WHERE ${conds.join(" AND ")}) AS matching_sessions`,
    `IF(returned_groups IS NULL, NULL, ${sameGroup}) AS returned_same_group`,
  ];
}

const CAMPMINDER: ReportDataset[] = ["enrollments", "camper_seasons", "program_families", "families"];

/** Revenue counts by program/service date unless the report says otherwise. */
export function effectiveFilters(spec: ReportSpec): Record<string, string[]> {
  const filters = Object.fromEntries(Object.entries(spec.filters).filter(([, v]) => v.length > 0));
  if (
    spec.dataset === "revenue" &&
    !filters.date_basis &&
    !spec.exclude.date_basis?.length &&
    !spec.rows.includes("date_basis") &&
    spec.column !== "date_basis"
  ) {
    filters.date_basis = ["Program / service date"];
  }
  return filters;
}

export function compileReport(spec: ReportSpec, marts: string, families: ProgramFamilySettings, schools: SchoolMap = new Map()) {
  const filters = effectiveFilters(spec);
  const exclude = Object.fromEntries(Object.entries(spec.exclude).filter(([, v]) => v.length > 0));
  const usesWeek = spec.rows.includes("week") || spec.column === "week" || "week" in filters || "week" in exclude;
  const ds = datasetSql(spec.dataset, marts, usesWeek);
  // Multi-valued fields shown as rows or columns: one record per value (mv_<field>); a record with none counts under (none).
  const multi = ds.multi ?? {};
  const valuesOf = (array: string) => `UNNEST(IF(ARRAY_LENGTH(${array}) > 0, ${array}, [CAST(NULL AS STRING)]))`;
  const exploded = [...spec.rows, ...(spec.column ? [spec.column] : [])].filter((id) => id in multi);
  const source = exploded.length
    ? `SELECT s0.*, ${exploded.map((id) => `mv_${id}`).join(", ")} FROM (SELECT * FROM ${ds.from}) AS s0, ${exploded.map((id) => `${valuesOf(`s0.${multi[id]}`)} AS mv_${id}`).join(", ")}`
    : `SELECT * FROM ${ds.from}`;
  const field = (id: string) => {
    const sql = id in multi ? `mv_${id}` : ds.fields[id];
    if (!sql) throw new Error(`Unknown field ${id}`);
    return `COALESCE(${sql}, '${NONE_VALUE}')`;
  };
  const measure = ds.measures[spec.measure];
  if (!measure) throw new Error(`Unknown measure ${spec.measure}`);

  const params: Record<string, unknown> = {};
  const types: Record<string, unknown> = {};
  const where: string[] = ["TRUE"];
  const filterParam: Record<string, string> = {};
  Object.entries(filters).forEach(([id, values], i) => {
    params[`f${i}`] = values;
    types[`f${i}`] = ["STRING"];
    filterParam[id] = `f${i}`;
    // A multi-valued filter that isn't split out keeps records with any of the values, once each.
    where.push(
      id in multi && !exploded.includes(id)
        ? `EXISTS (SELECT 1 FROM ${valuesOf(multi[id]!)} AS v WHERE COALESCE(v, '${NONE_VALUE}') IN UNNEST(@f${i}))`
        : `${field(id)} IN UNNEST(@f${i})`,
    );
  });
  // Exclusions leave out a record with any of the values (for a multi-valued field: a camper who attended any of them).
  Object.entries(exclude).forEach(([id, values], i) => {
    params[`x${i}`] = values;
    types[`x${i}`] = ["STRING"];
    where.push(
      id in multi
        ? `NOT EXISTS (SELECT 1 FROM ${valuesOf(multi[id]!)} AS v WHERE COALESCE(v, '${NONE_VALUE}') IN UNNEST(@x${i}))`
        : `${field(id)} NOT IN UNNEST(@x${i})`,
    );
  });
  if (ds.dateColumn) {
    params.start = spec.start;
    params.end = spec.end;
    types.start = "DATE";
    types.end = "DATE";
    where.push(`${ds.dateColumn} BETWEEN @start AND @end`);
  }
  if (CAMPMINDER.includes(spec.dataset) || spec.dataset === "campminder_finance") {
    params.pf = Object.entries(families.overrides).map(([program, v]) => ({ program, family: v.family, branch: v.branch }));
    types.pf = [{ program: "STRING", family: "STRING", branch: "STRING" }];
  }
  if (CAMPMINDER.includes(spec.dataset)) {
    const sp = schoolParams(schools);
    Object.assign(params, sp.params);
    Object.assign(types, sp.types);
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
    WITH ${[...ds.ctes, `src AS (${source})`].join(",\n  ")},
    picked AS (
      SELECT src.*${[...dims, ...(ds.computed?.({ exploded, filterParam }) ?? [])].map((d) => `, ${d}`).join("")}
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
