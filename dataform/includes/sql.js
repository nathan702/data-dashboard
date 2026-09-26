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

/**
 * One-time migration for tables that used to be partitioned by day. Full
 * rebuilds every 15 minutes rewrote thousands of daily partitions and hit
 * BigQuery's per-table daily partition-modification quota. BigQuery can't
 * drop partitioning in place, so drop the old table once; later runs see an
 * unpartitioned table and skip this.
 */
function dropIfPartitioned(dataset, table) {
  return `
    IF EXISTS (
      SELECT 1 FROM \`${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = '${table}' AND is_partitioning_column = 'YES'
    ) THEN
      DROP TABLE \`${dataset}.${table}\`;
    END IF;`;
}

module.exports.dropIfPartitioned = dropIfPartitioned;
