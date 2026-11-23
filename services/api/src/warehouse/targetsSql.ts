/**
 * SQL for targets: per measure, this season's total so far, and last season's
 * total at the same point (booked by @cutoff) and in full. Request values are
 * parameters; dates are passed as text and cast (DATE parameters arrive empty).
 */
const D = (p: string) => `CAST(@${p} AS DATE)`;
const IN_CUR = (col: string) => `${col} BETWEEN ${D("cur_start")} AND ${D("cur_end")}`;
const IN_PREV = (col: string) => `${col} BETWEEN ${D("prev_start")} AND ${D("prev_end")}`;
const IN_EITHER = (col: string) => `${col} BETWEEN LEAST(${D("prev_start")}, ${D("cur_start")}) AND GREATEST(${D("prev_end")}, ${D("cur_end")})`;

/** Ranged measures: rows with a date in the season and a value, counted when booked. */
const ranged = (measure: string, from: string, dateCol: string, bookedCol: string, value: string, where: string) => `
    SELECT
      '${measure}' AS measure,
      SUM(IF(${IN_CUR(dateCol)}, ${value}, 0)) AS current,
      SUM(IF(${IN_PREV(dateCol)} AND ${bookedCol} <= ${D("cutoff")}, ${value}, 0)) AS prev_sp,
      SUM(IF(${IN_PREV(dateCol)}, ${value}, 0)) AS prev_final
    FROM ${from}
    WHERE business_line = @business_line AND ${where} AND ${IN_EITHER(dateCol)}`;

export function targetActualsSql(dataset: string) {
  const t = (name: string) => `\`${dataset}.${name}\``;
  const participants = `COALESCE((SELECT SUM(SAFE_CAST(value AS NUMERIC)) FROM UNNEST(props) WHERE name IN UNNEST(@p_participants)), 0)`;
  // Campminder seasons are numbered; last season counts sign-ups made by the same point (current status).
  const cur = "season = @season AND status_code = 'EN'";
  const prevFinal = "season = @season - 1 AND status_code = 'EN'";
  const prevSp = `${prevFinal} AND (application_date IS NULL OR application_date <= ${D("cutoff")})`;
  // Campers: distinct people; enrollments: camper-sessions (one row each), as on the Camp pages.
  const enrolled = (count: (cond: string) => string) => `
      ${count(cur)} AS current, ${count(prevSp)} AS prev_sp, ${count(prevFinal)} AS prev_final`;
  const campers = (c: string) => `COUNT(DISTINCT IF(${c}, camper_hash, NULL))`;
  const sessions = (c: string) => `COUNTIF(${c})`;
  return [
    ranged("revenue", t("fct_revenue_pace"), "service_date", "booked_date", "CAST(net AS FLOAT64)", "TRUE"),
    ranged("guests", t("fct_fareharbor_bookings"), "service_date", "COALESCE(booked_date, service_date)", "guests", "TRUE"),
    ranged("participants", t("fct_hubspot_deals"), "service_date", "COALESCE(close_date, service_date)", `CAST(${participants} AS FLOAT64)`, "is_won"),
    `
    SELECT 'campers' AS measure, ${enrolled(campers)}
    FROM ${t("fct_campminder_enrollments")}
    WHERE business_line = @business_line AND season IN (@season, @season - 1)`,
    `
    SELECT 'enrollments' AS measure, ${enrolled(sessions)}
    FROM ${t("fct_campminder_enrollments")}
    WHERE business_line = @business_line AND season IN (@season, @season - 1)`,
  ].join("\n    UNION ALL");
}
