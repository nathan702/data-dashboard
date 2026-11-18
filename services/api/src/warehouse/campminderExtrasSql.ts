/**
 * Camp extras: Summer Camp charge and credit lines whose item (the week dropped)
 * is one of @items, the line items chosen on Settings. Only the Summer Camp
 * financial category counts.
 * One row per season, item, week and session group; this season in full and
 * last season up to @cutoff (a year before today). Each line is one item: a
 * reversal takes one back.
 */
export function campminderExtrasSql(marts: string): string {
  return `
    SELECT
      season,
      item_group AS item,
      item_week AS week,
      COALESCE(session_group, item_session_group) AS session_group,
      SUM(IF(type = 'debit', IF(is_reversal, -1, 1), 0)) AS count,
      SUM(amount) AS revenue
    FROM \`${marts}.fct_campminder_transactions\`
    WHERE type IN ('debit', 'credit')
      AND category = @category
      AND item_group IN UNNEST(@items)
      AND (@business_line IS NULL OR business_line = @business_line)
      AND (season = @season OR (season = @season - 1 AND post_date <= CAST(@cutoff AS DATE)))
    GROUP BY 1, 2, 3, 4`;
}

/** Every Summer Camp line item (the week dropped), with its lines and net amount, for choosing extras on Settings. */
export function campLineItemsSql(marts: string): string {
  return `
    SELECT item_group AS item, COUNT(*) AS lines, SUM(amount) AS amount
    FROM \`${marts}.fct_campminder_transactions\`
    WHERE type IN ('debit', 'credit') AND category = @category AND item_group IS NOT NULL
    GROUP BY 1
    ORDER BY lines DESC
    LIMIT 500`;
}
