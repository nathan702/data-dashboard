import type { EnrollmentDimension } from "@dash/shared";

/**
 * SQL for Campminder enrollments (marts.fct_campminder_enrollments). Only
 * these fixed fragments are interpolated; request values are parameters.
 */
const FILTER = "(@business_line IS NULL OR business_line = @business_line)";

const KEY_SQL: Record<Exclude<EnrollmentDimension, "week">, string> = {
  session_group: "session_group",
  session: "session_name",
  program: "program",
  age: "CAST(age_at_season AS STRING)",
  grade: "school_grade",
  gender: "gender",
  years: "CAST(years_as_camper AS STRING)",
  state: "home_state",
  status: "status",
};

const COUNTS = `
  COUNT(DISTINCT IF(status_code = 'EN', camper_hash, NULL)) AS campers,
  COUNTIF(status_code = 'EN') AS enrollments,
  COUNTIF(status_code = 'CN') AS cancelled,
  COUNTIF(status_code = 'WD') AS withdrawn,
  COUNTIF(status_code = 'WL') AS waitlisted`;

export function seasonsSql(t: string) {
  return `
    SELECT season, COUNTIF(status_code = 'EN') AS enrollments
    FROM ${t}
    WHERE ${FILTER}
    GROUP BY 1
    ORDER BY 1 DESC`;
}

export function kpiSql(t: string) {
  return `
    WITH scoped AS (
      SELECT 'current' AS period, * FROM ${t} WHERE ${FILTER} AND season = @season
      UNION ALL
      -- Last season as of the same point: what had been applied for by then.
      SELECT 'comparison', * FROM ${t}
      WHERE ${FILTER} AND season = @season - 1 AND (application_date IS NULL OR application_date <= @prev_cutoff)
    )
    SELECT
      period,
      ${COUNTS},
      COUNT(DISTINCT IF(status_code = 'EN' AND years_as_camper = 1, camper_hash, NULL)) AS new_campers,
      COUNT(DISTINCT IF(status_code = 'EN' AND years_as_camper > 1, camper_hash, NULL)) AS returning_campers
    FROM scoped
    GROUP BY 1`;
}

export function byWeekSql(t: string) {
  return `
    SELECT week, COUNT(*) AS enrollments
    FROM ${t}, UNNEST(GENERATE_ARRAY(week_start, week_end)) AS week
    WHERE ${FILTER} AND season = @season AND status_code = 'EN' AND is_weekly
    GROUP BY 1
    ORDER BY 1`;
}

export function paceSql(t: string) {
  return `
    SELECT
      season,
      LEAST(DIV(DATE_DIFF(GREATEST(application_date, season_start_date), season_start_date, DAY), 7), 52) AS week_of_season,
      COUNT(*) AS enrollments
    FROM ${t}
    WHERE ${FILTER} AND season IN (@season, @season - 1) AND status_code = 'EN' AND application_date IS NOT NULL
    GROUP BY 1, 2`;
}

export function breakdownSql(t: string, dimension: EnrollmentDimension) {
  if (dimension === "week") {
    return `
      SELECT CAST(week AS STRING) AS key, ${COUNTS}
      FROM ${t}, UNNEST(GENERATE_ARRAY(week_start, week_end)) AS week
      WHERE ${FILTER} AND season = @season AND is_weekly
      GROUP BY 1`;
  }
  return `
    SELECT COALESCE(${KEY_SQL[dimension]}, '(unknown)') AS key, ${COUNTS}
    FROM ${t}
    WHERE ${FILTER} AND season = @season
    GROUP BY 1`;
}
