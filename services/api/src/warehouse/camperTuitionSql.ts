/**
 * Net tuition per camper: every charge and discount/credit line of
 * Campminder's Financial report (marts.fct_campminder_transactions) given to
 * campers. Shared by the Tuition card (camperTuitionCardSql) and the report
 * builder's Campers by season data set (reportSql.ts), so they can't disagree.
 *
 * - A line under a camper (the person is a camper that season) is that camper's.
 * - Any other line (a discount or fee under a parent) is split across the
 *   household's campers enrolled in its session (a line with no session: in its
 *   business line), in proportion to each one's charges there; evenly when
 *   none of them has charges. A line with no such camper stays unassigned.
 * - Extras (@category line items in @extras: lunches, gear) are kept apart from tuition.
 *
 * Result (CTE tuition_alloc): season, business_line, camper_hash (NULL:
 * unassigned), session_name, enrolled (counted per camper: the camper is
 * enrolled in the line's session, or, for a line with no session, in its
 * business line), tuition, extras.
 *
 * `scope` "pair" keeps @season, and @season − 1 as of @prev_cutoff (lines
 * posted and campers applied by then); "all" keeps every season.
 */
export function camperTuitionCtes(lines: string, enrollments: string, scope: "pair" | "all"): string[] {
  const txScope = scope === "pair" ? "(season = @season OR (season = @season - 1 AND post_date <= CAST(@prev_cutoff AS DATE)))" : "TRUE";
  const enrScope =
    scope === "pair"
      ? "(season = @season OR (season = @season - 1 AND (application_date IS NULL OR application_date <= CAST(@prev_cutoff AS DATE))))"
      : "TRUE";
  return [
    `tuition_tx AS (
    SELECT line_id, season, business_line, person_hash, family_hash, session_name, type, CAST(amount AS FLOAT64) AS amount,
      COALESCE(category = @category AND item_group IN UNNEST(@extras), FALSE) AS is_extra
    FROM ${lines}
    WHERE type IN ('debit', 'credit') AND ${txScope}
  )`,
    `tuition_enr AS (
    SELECT season, business_line, camper_hash, family_hash, session_name, status_code
    FROM ${enrollments}
    WHERE ${enrScope}
  )`,
    `tuition_campers AS (SELECT DISTINCT season, camper_hash FROM tuition_enr)`,
    // 1. Lines under a camper.
    `tuition_direct AS (
    SELECT t.*, c.camper_hash
    FROM tuition_tx AS t
    JOIN tuition_campers AS c ON c.season = t.season AND c.camper_hash = t.person_hash
  )`,
    `tuition_other AS (
    SELECT t.*
    FROM tuition_tx AS t
    LEFT JOIN tuition_campers AS c ON c.season = t.season AND c.camper_hash = t.person_hash
    WHERE c.camper_hash IS NULL
  )`,
    // Each camper's charges in a session and in a business line: how a household line is split.
    `tuition_w_session AS (
    SELECT season, camper_hash, session_name, SUM(IF(type = 'debit', amount, 0)) AS charges
    FROM tuition_direct WHERE session_name IS NOT NULL GROUP BY 1, 2, 3
  )`,
    `tuition_w_line AS (
    SELECT season, camper_hash, business_line, SUM(IF(type = 'debit', amount, 0)) AS charges
    FROM tuition_direct GROUP BY 1, 2, 3
  )`,
    // 2. The household's enrolled campers each other line could be for, weighted by their charges.
    `tuition_cand AS (
    SELECT o.line_id, r.camper_hash, GREATEST(COALESCE(w.charges, 0), 0) AS w
    FROM tuition_other AS o
    JOIN (SELECT DISTINCT season, family_hash, camper_hash, session_name FROM tuition_enr WHERE status_code = 'EN' AND family_hash IS NOT NULL) AS r
      ON r.season = o.season AND r.family_hash = o.family_hash AND r.session_name = o.session_name
    LEFT JOIN tuition_w_session AS w ON w.season = o.season AND w.camper_hash = r.camper_hash AND w.session_name = o.session_name
    WHERE o.session_name IS NOT NULL
    UNION ALL
    SELECT o.line_id, r.camper_hash, GREATEST(COALESCE(w.charges, 0), 0) AS w
    FROM tuition_other AS o
    JOIN (SELECT DISTINCT season, family_hash, camper_hash, business_line FROM tuition_enr WHERE status_code = 'EN' AND family_hash IS NOT NULL) AS r
      ON r.season = o.season AND r.family_hash = o.family_hash AND r.business_line = o.business_line
    LEFT JOIN tuition_w_line AS w ON w.season = o.season AND w.camper_hash = r.camper_hash AND w.business_line = o.business_line
    WHERE o.session_name IS NULL
  )`,
    `tuition_split AS (
    SELECT line_id, camper_hash,
      IF(SUM(w) OVER (PARTITION BY line_id) > 0, w / SUM(w) OVER (PARTITION BY line_id), 1 / COUNT(*) OVER (PARTITION BY line_id)) AS share
    FROM tuition_cand
  )`,
    `tuition_given AS (
    SELECT season, business_line, camper_hash, session_name, amount, is_extra FROM tuition_direct
    UNION ALL
    SELECT o.season, o.business_line, s.camper_hash, o.session_name, o.amount * s.share, o.is_extra
    FROM tuition_other AS o JOIN tuition_split AS s USING (line_id)
    UNION ALL
    SELECT o.season, o.business_line, CAST(NULL AS STRING), o.session_name, o.amount, o.is_extra
    FROM tuition_other AS o
    LEFT JOIN (SELECT DISTINCT line_id FROM tuition_split) AS s USING (line_id)
    WHERE s.line_id IS NULL
  )`,
    `tuition_alloc AS (
    SELECT g.season, g.business_line, g.camper_hash, g.session_name,
      -- Counted per camper: a session's lines when the camper is enrolled in that session (a cancelled
      -- session's charge isn't), a line with no session when the camper is enrolled in its business line.
      IF(g.session_name IS NULL, el.camper_hash IS NOT NULL, es.camper_hash IS NOT NULL) AS enrolled,
      SUM(IF(g.is_extra, 0, g.amount)) AS tuition,
      SUM(IF(g.is_extra, g.amount, 0)) AS extras
    FROM tuition_given AS g
    LEFT JOIN (SELECT DISTINCT season, business_line, camper_hash FROM tuition_enr WHERE status_code = 'EN') AS el
      ON el.season = g.season AND el.business_line = g.business_line AND el.camper_hash = g.camper_hash
    LEFT JOIN (SELECT DISTINCT season, camper_hash, session_name FROM tuition_enr WHERE status_code = 'EN') AS es
      ON es.season = g.season AND es.camper_hash = g.camper_hash AND es.session_name = g.session_name
    GROUP BY 1, 2, 3, 4, 5
  )`,
  ];
}

/**
 * The Tuition card's per-camper figures for @season and @season − 1 (as of
 * @prev_cutoff), for one business line (or all). Without filters: every
 * enrolled camper and everything given to them. With filters (drill-down
 * clauses over `view`): the matching enrolled camper-sessions and what was
 * given to those sessions (lines with no session left out, as on the card).
 */
export function camperTuitionCardSql(lines: string, enrollments: string, view: string, drill: string, filtered: boolean) {
  const line = "(@business_line IS NULL OR business_line = @business_line)";
  const money = filtered
    ? `SELECT a.season, SUM(a.tuition) AS tuition, SUM(a.extras) AS extras, 0 AS not_per_camper
       FROM tuition_alloc AS a
       JOIN (SELECT DISTINCT season, camper_hash, session_name FROM kept) AS k USING (season, camper_hash, session_name)
       WHERE (@business_line IS NULL OR a.business_line = @business_line)
       GROUP BY 1`
    : `SELECT season, SUM(IF(enrolled, tuition, 0)) AS tuition, SUM(IF(enrolled, extras, 0)) AS extras,
         SUM(IF(enrolled, 0, tuition + extras)) AS not_per_camper
       FROM tuition_alloc WHERE ${line} GROUP BY 1`;
  return `
    WITH ${camperTuitionCtes(lines, enrollments, "pair").join(",\n    ")},
    kept AS (
      SELECT season, camper_hash, session_name, IF(is_weekly AND week_start IS NOT NULL, week_end - week_start + 1, 0) AS weeks
      FROM ${view}
      WHERE status_code = 'EN' AND ${line}
        AND (season = @season OR (season = @season - 1 AND (application_date IS NULL OR application_date <= CAST(@prev_cutoff AS DATE))))
        AND ${filtered ? drill : "TRUE"}
    ),
    money AS (${money}),
    people AS (SELECT season, COUNT(DISTINCT camper_hash) AS campers, SUM(weeks) AS weeks FROM kept GROUP BY 1),
    has_lines AS (SELECT season, COUNT(*) AS lines FROM tuition_tx WHERE ${line} GROUP BY 1)
    SELECT s AS season, COALESCE(p.campers, 0) AS campers, COALESCE(p.weeks, 0) AS weeks,
      COALESCE(m.tuition, 0) AS tuition, COALESCE(m.extras, 0) AS extras, COALESCE(m.not_per_camper, 0) AS not_per_camper,
      COALESCE(h.lines, 0) AS lines
    FROM UNNEST([@season, @season - 1]) AS s
    LEFT JOIN people AS p ON p.season = s
    LEFT JOIN money AS m ON m.season = s
    LEFT JOIN has_lines AS h ON h.season = s`;
}
