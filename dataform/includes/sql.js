/** Eastern-time calendar date for a TIMESTAMP expression. */
function easternDate(ts) {
  return `DATE(${ts}, "America/New_York")`;
}

/** Latest version of each record in a raw table, excluding deletions. */
function latestRaw(rawTable) {
  return `
    SELECT * EXCEPT (rn) FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY record_id ORDER BY source_updated_at DESC, ingested_at DESC
      ) AS rn
      FROM ${rawTable}
    )
    WHERE rn = 1 AND NOT is_deleted`;
}

module.exports = { easternDate, latestRaw };
