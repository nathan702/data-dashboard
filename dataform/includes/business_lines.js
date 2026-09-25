/**
 * Business line ids (must match packages/shared/src/businessLines.ts) and the
 * built-in default assignments. Anything saved on the dashboard's Settings
 * page (config.business_line_map) overrides these.
 */
const BUSINESS_LINES = [
  "camp", "river_school", "events", "haunted_forest", "chaps",
  "education", "school_year", "river_store", "farm_store",
];

/** Defaults matched on the value's display name, case-insensitively. */
const DEFAULT_ASSIGNMENTS = [
  { source: "square", kind: "location", label: "Farm Store", businessLine: "farm_store" },
  { source: "square", kind: "location", label: "MHF", businessLine: "haunted_forest" },
  { source: "square", kind: "location", label: "Events", businessLine: "events" },
  { source: "square", kind: "location", label: "Pizza Nights", businessLine: "events" },
  { source: "shopify", kind: "store", label: "Shopify store", businessLine: "river_store" },
];

const q = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** SQL CASE giving the default business line for (source, kind, label), or NULL. */
function defaultAssignmentSql(source, kind, label) {
  const whens = DEFAULT_ASSIGNMENTS.map(
    (d) => `WHEN ${source} = ${q(d.source)} AND ${kind} = ${q(d.kind)} AND LOWER(TRIM(${label})) = ${q(d.label.toLowerCase())} THEN ${q(d.businessLine)}`,
  );
  return `CASE ${whens.join(" ")} ELSE NULL END`;
}

module.exports = { BUSINESS_LINES, DEFAULT_ASSIGNMENTS, defaultAssignmentSql, q };
