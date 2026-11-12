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
