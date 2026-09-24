/** Eastern-time calendar date for a TIMESTAMP expression. */
function easternDate(ts) {
  return `DATE(${ts}, "America/New_York")`;
}

/** Latest version of each record in a raw table, excluding deletions. */
function latestRaw(rawTable, { includeDeleted = false } = {}) {
  return `
    SELECT * EXCEPT (rn) FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY record_id ORDER BY source_updated_at DESC, ingested_at DESC
      ) AS rn
      FROM ${rawTable}
    )
    WHERE rn = 1${includeDeleted ? "" : " AND NOT is_deleted"}`;
}

/** Square money object (integer cents) at a JSON path → dollars, 0 when missing. */
function squareMoney(json, path) {
  return `COALESCE(SAFE_CAST(JSON_VALUE(${json}, '${path}.amount') AS NUMERIC), 0) / 100`;
}

/** Shopify MoneyBag (shop currency) at a JSON path → NUMERIC, 0 when missing. */
function shopMoney(json, path) {
  return `COALESCE(SAFE_CAST(JSON_VALUE(${json}, '${path}.shopMoney.amount') AS NUMERIC), 0)`;
}

function ts(json, path) {
  return `SAFE_CAST(JSON_VALUE(${json}, '${path}') AS TIMESTAMP)`;
}

module.exports = { easternDate, latestRaw, squareMoney, shopMoney, ts };
