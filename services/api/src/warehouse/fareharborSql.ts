import { LEAD_BUCKETS } from "@dash/shared";

/**
 * SQL for the FareHarbor days endpoint. Only fixed strings are interpolated;
 * request values are query parameters, and dates are passed as text and cast
 * (DATE-typed parameters arrive empty).
 */
const LEAD_DAYS = "DATE_DIFF(service_date, COALESCE(booked_date, service_date), DAY)";
const leadCase = () => {
  const bounds: Array<[string, number]> = [["0", 0], ["1", 1], ["2-3", 3], ["4-6", 6], ["7-13", 13], ["14-20", 20], ["21-27", 27], ["28-41", 41], ["42-55", 55]];
  if (bounds.length !== LEAD_BUCKETS.length - 1) throw new Error("lead buckets out of sync");
  return `CASE ${bounds.map(([b, max]) => `WHEN ${LEAD_DAYS} <= ${max} THEN '${b}'`).join(" ")} ELSE '56+' END`;
};

export function fareharborDaysSql(dataset: string) {
  return `
    SELECT
      CAST(IF(@nightly, service_date, DATE_TRUNC(service_date, WEEK(MONDAY))) AS STRING) AS day,
      item_name AS item,
      ${leadCase()} AS lead,
      SUM(revenue) AS revenue,
      SUM(guests) AS guests,
      COUNTIF(status IS DISTINCT FROM 'cancelled') AS bookings,
      SUM(IF(booked_date <= CAST(@cutoff AS DATE), revenue, 0)) AS revenue_sp,
      SUM(IF(booked_date <= CAST(@cutoff AS DATE), guests, 0)) AS guests_sp
    FROM \`${dataset}.fct_fareharbor_bookings\`
    WHERE business_line = @business_line
      AND service_date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)
    GROUP BY 1, 2, 3`;
}

export function fareharborExtentSql(dataset: string) {
  return `
    SELECT CAST(MIN(service_date) AS STRING) AS first_day, CAST(MAX(service_date) AS STRING) AS last_day
    FROM \`${dataset}.fct_fareharbor_bookings\`
    WHERE business_line = @business_line`;
}
