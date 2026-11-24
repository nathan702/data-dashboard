import { BUSINESS_LINE_INFO, BUSINESS_LINES, NEW_FAMILY, RETURNING_FAMILY } from "@dash/shared";

/** A business line's name in SQL (fixed fragments only): "CHAPs", "School Year Programs"… */
const LINE_LABEL = `CASE x ${BUSINESS_LINES.map((l) => `WHEN '${l}' THEN '${BUSINESS_LINE_INFO[l].label.replace(/'/g, "''")}'`).join(" ")} ELSE x END`;

/**
 * Each household's standing in a business line and season (a camper without a
 * household is its own), to join on season, business_line and fam:
 * - new_family: NEW_FAMILY in its first season with an enrolled camper in that
 *   line (in the first season of data, when every camper is in their first
 *   year at camp), else RETURNING_FAMILY.
 * - came_through: for a new family, the other Campminder line it was enrolled
 *   in first (an earlier season, or earlier the same season), "<line> first";
 *   else "Directly". Null for returning families.
 */
export function familyStatusSql(table: string) {
  return `(
      WITH fam_line AS (
        SELECT season, business_line, COALESCE(family_hash, camper_hash) AS fam,
          MAX(years_as_camper) AS max_years, MIN(application_date) AS first_app
        FROM ${table}
        WHERE status_code = 'EN'
        GROUP BY 1, 2, 3
      ),
      firsts AS (SELECT business_line, fam, MIN(season) AS first_season FROM fam_line GROUP BY 1, 2),
      before_line AS (
        -- The other line each new family was in first: its earliest season there, then earliest application.
        SELECT a.season, a.business_line, a.fam,
          ARRAY_AGG(o.business_line ORDER BY o.season, o.first_app LIMIT 1)[OFFSET(0)] AS x
        FROM fam_line AS a
        JOIN fam_line AS o
          ON o.fam = a.fam AND o.business_line != a.business_line
          AND (o.season < a.season OR (o.season = a.season AND o.first_app < a.first_app))
        GROUP BY 1, 2, 3
      )
      SELECT f.season, f.business_line, f.fam,
        CASE
          WHEN f.season > fi.first_season THEN '${RETURNING_FAMILY}'
          WHEN f.season = (SELECT MIN(season) FROM fam_line) AND COALESCE(f.max_years, 1) > 1 THEN '${RETURNING_FAMILY}'
          ELSE '${NEW_FAMILY}'
        END AS new_family,
        CASE
          WHEN f.season > fi.first_season THEN NULL
          WHEN f.season = (SELECT MIN(season) FROM fam_line) AND COALESCE(f.max_years, 1) > 1 THEN NULL
          WHEN b.x IS NULL THEN 'Directly'
          ELSE CONCAT((SELECT ${LINE_LABEL} FROM UNNEST([b.x]) AS x), ' first')
        END AS came_through
      FROM fam_line AS f
      JOIN firsts AS fi ON fi.business_line = f.business_line AND fi.fam = f.fam
      LEFT JOIN before_line AS b ON b.season = f.season AND b.business_line = f.business_line AND b.fam = f.fam
    )`;
}
