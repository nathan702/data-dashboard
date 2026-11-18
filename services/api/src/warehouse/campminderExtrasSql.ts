/**
 * Camp extras (Lunches, Gear Bag, Backpack…): charge and credit lines in
 * the Miscellaneous or System financial category (or none) that name an item,
 * plus items named like @extra_pattern in any category (lunches and gear are
 * filed under Summer Camp).
 * One row per season, item (the week dropped), week and session group;
 * this season in full and last season up to @cutoff (a year before today).
 * Each line is one item: a reversal takes one back.
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
      AND item IS NOT NULL
      AND (category IS NULL OR category IN ('Miscellaneous', 'System') OR REGEXP_CONTAINS(item, CONCAT('(?i)', @extra_pattern)))
      AND (@business_line IS NULL OR business_line = @business_line)
      AND (season = @season OR (season = @season - 1 AND post_date <= CAST(@cutoff AS DATE)))
    GROUP BY 1, 2, 3, 4`;
}
