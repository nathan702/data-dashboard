import {
  businessLineLabel,
  fieldSortKey,
  isBusinessLineOrUnassigned,
  NONE_VALUE,
  type ReportDatasetInfo,
  type ReportField,
  type ReportMeasure,
  type ReportResult,
} from "@dash/shared";

/**
 * A report result arranged for display: sorted row and column keys, every
 * total from the database, and shares (% of row / column / total) computed
 * against those totals.
 */
export interface Pivot {
  rowFields: ReportField[];
  colField: ReportField | null;
  measure: ReportMeasure;
  rowKeys: string[][];
  colKeys: string[];
  value(row: string[], col: string | null): number | null;
  rowTotal(row: string[]): number | null;
  colTotal(col: string): number | null;
  total: number | null;
  /** Shown number: the value or its share, per the report's percent setting. */
  shown(v: number | null, row: string[] | null, col: string | null): number | null;
  percent: boolean;
  /** Change of the shown number from the previous column (null for the first column or a missing value). */
  change(row: string[] | null, col: string): { diff: number; pct: number | null } | null;
  changeMode: ReportResult["spec"]["change"];
}

const k = (row: string[]) => row.join("␟");

export function buildPivot(result: ReportResult, info: ReportDatasetInfo): Pivot {
  const spec = result.spec;
  const rowFields = spec.rows.map((id) => info.fields.find((f) => f.id === id)!);
  const colField = spec.column ? info.fields.find((f) => f.id === spec.column)! : null;
  const measure = info.measures.find((m) => m.id === spec.measure)!;
  const cells = new Map<string, number | null>();
  const rowTotals = new Map<string, number | null>();
  const colTotals = new Map<string, number | null>();
  let total: number | null = null;
  const rowSet = new Map<string, string[]>();
  const colSet = new Set<string>();
  for (const c of result.cells) {
    if (c.kind === "cell") {
      cells.set(`${k(c.rows)}|${c.column ?? ""}`, c.value);
      rowSet.set(k(c.rows), c.rows);
      if (c.column !== null) colSet.add(c.column);
    } else if (c.kind === "row_total") rowTotals.set(k(c.rows), c.value);
    else if (c.kind === "column_total") colTotals.set(c.column!, c.value);
    else total = c.value;
  }
  // Without a column, a row's value is its total.
  const rowTotal = (row: string[]) => (colField ? rowTotals.get(k(row)) ?? null : cells.get(`${k(row)}|`) ?? null);
  const colTotal = (col: string) => colTotals.get(col) ?? null;

  const cmp = (a: number | string, b: number | string) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
  const rowKeys = [...rowSet.values()].sort((a, b) => {
    for (let i = 0; i < rowFields.length; i++) {
      const f = rowFields[i]!;
      // Text fields: biggest first (by row total) when it's the only field; otherwise A–Z.
      if (f.order === "text" && rowFields.length === 1) {
        if (a[i] === NONE_VALUE || b[i] === NONE_VALUE) return a[i] === NONE_VALUE ? 1 : -1;
        const d = (rowTotal(b) ?? 0) - (rowTotal(a) ?? 0);
        if (d !== 0) return d;
      }
      const c = cmp(fieldSortKey(f.order, a[i]!), fieldSortKey(f.order, b[i]!));
      if (c !== 0) return c;
    }
    return 0;
  });
  const colKeys = [...colSet].sort((a, b) => {
    if (colField!.order === "text") {
      if (a === NONE_VALUE || b === NONE_VALUE) return a === NONE_VALUE ? 1 : -1;
      const d = (colTotal(b) ?? 0) - (colTotal(a) ?? 0);
      if (d !== 0) return d;
    }
    return cmp(fieldSortKey(colField!.order, a), fieldSortKey(colField!.order, b));
  });

  const share = (v: number | null, of: number | null) => (v === null || !of ? null : v / of);
  const value = (row: string[], col: string | null) => cells.get(`${k(row)}|${col ?? ""}`) ?? null;
  const shown = (v: number | null, row: string[] | null, col: string | null) => {
    switch (spec.percent) {
      case "none":
        return v;
      case "total":
        return share(v, total);
      case "row":
        return row ? share(v, rowTotal(row)) : share(v, total);
      case "column":
        return col !== null ? share(v, colTotal(col)) : share(v, total);
    }
  };
  // A row's cells (or the column totals, for row null) compared with the column before.
  const change = (row: string[] | null, col: string) => {
    const i = colKeys.indexOf(col);
    if (spec.change === "none" || i <= 0) return null;
    const at = (c: string) => shown(row ? value(row, c) : colTotal(c), row, c);
    const now = at(col);
    const before = at(colKeys[i - 1]!);
    if (now === null || before === null) return null;
    return { diff: now - before, pct: before === 0 ? null : (now - before) / Math.abs(before) };
  };
  return {
    rowFields,
    colField,
    measure,
    rowKeys,
    colKeys,
    value,
    rowTotal,
    colTotal,
    total,
    percent: spec.percent !== "none",
    shown,
    change,
    changeMode: spec.change,
  };
}

/** Field values as people should read them (business line ids → names). */
export function displayValue(field: ReportField | null, v: string): string {
  if ((field?.id === "business_line" || field?.id === "also_business_line") && isBusinessLineOrUnassigned(v)) return businessLineLabel(v);
  if (field?.id === "week" && v !== NONE_VALUE) return `Week ${v}`;
  return v;
}

/** A change from the previous column, signed: "+12", "−3.5%". */
export function formatChange(c: { diff: number; pct: number | null }, mode: "difference" | "percent", format: ReportMeasure["format"] | "share"): string {
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "±");
  if (mode === "percent") return c.pct === null ? "–" : `${sign(c.pct)}${formatMeasure(Math.abs(c.pct), "share")}`;
  return `${sign(c.diff)}${formatMeasure(Math.abs(c.diff), format)}`;
}

export function formatMeasure(v: number | null, format: ReportMeasure["format"] | "share"): string {
  if (v === null) return "–";
  switch (format) {
    case "money":
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
    case "decimal":
      return v.toFixed(2);
    case "percent":
    case "share":
      return `${(v * 100).toFixed(1)}%`;
    default:
      return new Intl.NumberFormat("en-US").format(Math.round(v));
  }
}
