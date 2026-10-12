import { REPORT_CELL_LIMIT, type ReportCell, type ReportResult, type ReportSpec } from "@dash/shared";

/** Raw grouped rows (r0, r1, c, value, g_row, g_col) → typed cells; cells beyond the limit are dropped, totals kept. */
export function toReportResult(spec: ReportSpec, rows: Array<Record<string, unknown>>): ReportResult {
  const hasRows = spec.rows.length > 0;
  const hasCol = !!spec.column;
  const cells: ReportCell[] = [];
  let shown = 0;
  let truncated = false;
  for (const r of rows) {
    const gRow = Number(r.g_row ?? 0) === 1;
    const gCol = Number(r.g_col ?? 0) === 1;
    let kind: ReportCell["kind"];
    if (!hasRows && !hasCol) kind = "total";
    else if (hasRows && hasCol) kind = gRow && gCol ? "total" : gRow ? "column_total" : gCol ? "row_total" : "cell";
    else kind = (hasRows ? gRow : gCol) ? "total" : "cell";
    if (kind === "cell" && ++shown > REPORT_CELL_LIMIT) {
      truncated = true;
      continue;
    }
    const v = r.value === null || r.value === undefined ? null : Number(r.value);
    cells.push({
      kind,
      rows: kind === "cell" || kind === "row_total" ? spec.rows.map((_, i) => String(r[`r${i}`])) : [],
      column: hasCol && (kind === "cell" || kind === "column_total") ? String(r.c) : null,
      value: v === null || Number.isNaN(v) ? null : Math.round(v * 10_000) / 10_000,
    });
  }
  return { spec, cells, truncated, generatedAt: new Date().toISOString() };
}
