/** SQL for the HubSpot deals endpoint; request values are parameters. */
export function hubspotOpenSql(dataset: string) {
  return `
    SELECT pipeline, stage, ANY_VALUE(stage_order) AS stage_order, COUNT(*) AS deals, SUM(amount) AS amount
    FROM \`${dataset}.fct_hubspot_deals\`
    WHERE business_line = @business_line AND NOT is_closed
    GROUP BY 1, 2
    ORDER BY 1, 3, 2`;
}

export function hubspotWonSql(dataset: string) {
  return `
    SELECT CAST(DATE_TRUNC(close_date, MONTH) AS STRING) AS month, COUNT(*) AS deals, SUM(amount) AS amount
    FROM \`${dataset}.fct_hubspot_deals\`
    WHERE business_line = @business_line AND is_won
      AND close_date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE("America/New_York"), MONTH), INTERVAL 23 MONTH)
    GROUP BY 1
    ORDER BY 1`;
}

/** Value of a kept property on a deal (the first of the names in an array parameter). */
const prop = (param: string) => `(SELECT value FROM UNNEST(props) WHERE name IN UNNEST(@${param}) ORDER BY name LIMIT 1)`;
/** Sum of the number properties named in an array parameter (null when none is filled in). */
const total = (param: string) => `(SELECT SUM(SAFE_CAST(value AS NUMERIC)) FROM UNNEST(props) WHERE name IN UNNEST(@${param}))`;

/**
 * Won deals with a program date in [from, to], grouped for the programs page.
 * "current" = on or after @cur_start; "previous" otherwise. Last season's deals
 * count at the same point when won (closed) on or before @cutoff.
 */
export function hubspotProgramsSql(dataset: string) {
  return `
    WITH d AS (
      SELECT
        IF(service_date >= CAST(@cur_start AS DATE), 'current', 'previous') AS period,
        close_date <= CAST(@cutoff AS DATE) AS at_same_point,
        CAST(DATE_TRUNC(service_date, MONTH) AS STRING) AS month,
        ${prop("p_type")} AS program_type,
        ${prop("p_food")} AS food,
        ${prop("p_transport")} AS transportation,
        amount,
        ${total("p_participants")} AS participants,
        ${total("p_chaperones")} AS chaperones
      FROM \`${dataset}.fct_hubspot_deals\`
      WHERE business_line = @business_line AND is_won
        AND service_date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)
    )
    SELECT
      period, at_same_point, month, program_type, food, transportation,
      COUNT(*) AS deals,
      SUM(amount) AS revenue,
      COALESCE(SUM(participants), 0) AS participants,
      COUNTIF(participants IS NOT NULL) AS deals_with_participants,
      COALESCE(SUM(chaperones), 0) AS chaperones,
      COUNTIF(chaperones IS NOT NULL) AS deals_with_chaperones
    FROM d
    GROUP BY 1, 2, 3, 4, 5, 6`;
}

export function hubspotLineItemsSql(dataset: string) {
  return `
    SELECT
      IF(service_date >= CAST(@cur_start AS DATE), 'current', 'previous') AS period,
      close_date <= CAST(@cutoff AS DATE) AS at_same_point,
      item,
      COALESCE(SUM(quantity), 0) AS quantity,
      SUM(amount) AS amount,
      COUNT(DISTINCT deal_id) AS deals
    FROM \`${dataset}.fct_hubspot_line_items\`
    WHERE business_line = @business_line AND is_won
      AND service_date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)
    GROUP BY 1, 2, 3`;
}

export function hubspotExtentSql(dataset: string) {
  return `
    SELECT CAST(MIN(service_date) AS STRING) AS first_day, CAST(MAX(service_date) AS STRING) AS last_day
    FROM \`${dataset}.fct_hubspot_deals\`
    WHERE business_line = @business_line AND is_won`;
}

export function hubspotPropertiesSql(dataset: string) {
  return `SELECT name, label, type, options FROM \`${dataset}.dim_hubspot_properties\` ORDER BY label`;
}
