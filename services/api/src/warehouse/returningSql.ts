/**
 * Returning families (see packages/shared/src/returning.ts): one row per
 * household per season S, for households with a camper enrolled at a camp
 * location (@locations: session group → va/md) in season S − 1, with what
 * that household did in Camp in season S. Only facts: statuses, waves and
 * age-out are worked out in TypeScript from these rows.
 *
 * A camper without a household counts as its own household, as in the
 * sign-up pace chart. @seasons limits the seasons S (empty: all).
 */
export function returningFamiliesSql(enrollments: string) {
  return `
    WITH locs AS (SELECT * FROM UNNEST(@locations)),
    last_season AS (
      SELECT
        e.season + 1 AS season,
        COALESCE(e.family_hash, e.camper_hash) AS fam,
        e.camper_hash,
        l.location,
        e.session_group,
        IF(e.is_weekly AND e.week_start IS NOT NULL, e.week_end - e.week_start + 1, 1) AS weeks,
        e.years_as_camper,
        e.age_at_season,
        e.home_state,
        e.home_zip
      FROM ${enrollments} AS e
      JOIN locs AS l ON l.session_group = e.session_group
      WHERE e.status_code = 'EN'
        AND (COALESCE(ARRAY_LENGTH(@seasons), 0) = 0 OR e.season + 1 IN UNNEST(@seasons))
    ),
    fam_last AS (
      SELECT
        season, fam,
        ARRAY_AGG(DISTINCT location ORDER BY location) AS locations,
        SUM(weeks) AS weeks,
        MAX(years_as_camper) AS summers,
        ANY_VALUE(home_state) AS state,
        ANY_VALUE(home_zip) AS zip
      FROM last_season
      GROUP BY 1, 2
    ),
    main_group AS (
      SELECT season, fam, ARRAY_AGG(session_group ORDER BY weeks DESC, session_group LIMIT 1)[OFFSET(0)] AS session_group
      FROM (SELECT season, fam, session_group, SUM(weeks) AS weeks FROM last_season GROUP BY 1, 2, 3)
      GROUP BY 1, 2
    ),
    this_season AS (
      SELECT season, COALESCE(family_hash, camper_hash) AS fam, camper_hash, status_code, application_date
      FROM ${enrollments}
      WHERE business_line = 'camp'
    ),
    fam_now AS (
      SELECT
        season, fam,
        LOGICAL_OR(status_code = 'EN') AS enrolled,
        LOGICAL_OR(status_code IN ('WL', 'AP')) AS waitlisted,
        LOGICAL_OR(status_code IN ('CN', 'WD')) AS cancelled,
        MIN(IF(status_code = 'EN', application_date, NULL)) AS enrolled_on
      FROM this_season
      GROUP BY 1, 2
    ),
    camper_list AS (
      SELECT c.season, c.fam, ARRAY_AGG(STRUCT(c.age AS age, n.camper_hash IS NOT NULL AS enrolled)) AS campers
      FROM (SELECT season, fam, camper_hash, MAX(age_at_season) AS age FROM last_season GROUP BY 1, 2, 3) AS c
      LEFT JOIN (SELECT DISTINCT season, camper_hash FROM this_season WHERE status_code = 'EN') AS n
        ON n.season = c.season AND n.camper_hash = c.camper_hash
      GROUP BY 1, 2
    )
    SELECT
      f.season,
      SUBSTR(f.fam, 1, 10) AS household,
      f.locations,
      g.session_group,
      f.weeks,
      f.summers,
      f.state,
      f.zip,
      c.campers,
      COALESCE(n.enrolled, FALSE) AS enrolled,
      COALESCE(n.waitlisted, FALSE) AS waitlisted,
      COALESCE(n.cancelled, FALSE) AS cancelled,
      CAST(n.enrolled_on AS STRING) AS enrolled_on
    FROM fam_last AS f
    JOIN main_group AS g USING (season, fam)
    JOIN camper_list AS c USING (season, fam)
    LEFT JOIN fam_now AS n USING (season, fam)`;
}

/** Plain count of each season's returning families, for the deploy self-check. */
export function returningFamiliesCountSql(enrollments: string) {
  return `
    SELECT e.season + 1 AS season, COUNT(DISTINCT COALESCE(e.family_hash, e.camper_hash)) AS families
    FROM ${enrollments} AS e
    WHERE e.status_code = 'EN' AND e.session_group IN UNNEST(@groups)
    GROUP BY 1`;
}
