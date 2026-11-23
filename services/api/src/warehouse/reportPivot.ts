import { NONE_VALUE, type ReportResult, type ReportSpec } from "@dash/shared";
import { effectiveFilters } from "./reportSql.js";
import { toReportResult } from "./reportResult.js";

/**
 * The report builder's pivot over records in memory, with the same rules as
 * the SQL in reportSql.ts: rows, an optional column, filters and exclusions,
 * multi-valued fields, and row, column and grand totals. Used for the demo
 * data and for data sets that don't live in BigQuery (targets).
 */
export type Rec = Record<string, unknown>;
export type Measure = (rs: Rec[]) => number | null;

const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

export function pivotRecords(
  spec: ReportSpec,
  all: Rec[],
  measures: Record<string, Measure>,
  opts: {
    /** Multi-valued fields: field id → the record's array of values. */
    multi?: Record<string, string>;
    /** Filters to apply (defaults to the report's own). */
    filters?: Record<string, string[]>;
    /** Extra values per record once filtered (e.g. campers' matching sessions). */
    computed?: (r: Rec, exploded: string[]) => Rec;
  } = {},
): ReportResult {
  const filters = opts.filters ?? effectiveFilters(spec);
  const exclude = Object.fromEntries(Object.entries(spec.exclude).filter(([, v]) => v.length > 0));
  // A multi-valued row or column splits each record by value; a multi-valued filter keeps it once.
  const multi = opts.multi ?? {};
  const list = (r: Rec, id: string) => {
    const vs = (r[multi[id]!] as string[] | undefined) ?? [];
    return vs.length ? vs : [null];
  };
  const exploded = [...spec.rows, ...(spec.column ? [spec.column] : [])].filter((id) => id in multi);
  const recs = exploded.reduce<Rec[]>((rs, id) => rs.flatMap((r) => list(r, id).map((v) => ({ ...r, [id]: v }))), all);
  const val = (r: Rec, id: string) => str(r[id]) ?? NONE_VALUE;
  const matches = (r: Rec, id: string, values: string[]) =>
    id in multi && !exploded.includes(id) ? list(r, id).some((v) => values.includes(v ?? NONE_VALUE)) : values.includes(val(r, id));
  const excluded = (r: Rec, id: string, values: string[]) =>
    id in multi ? list(r, id).some((v) => values.includes(v ?? NONE_VALUE)) : values.includes(val(r, id));
  const picked = recs
    .filter((r) => Object.entries(filters).every(([id, values]) => matches(r, id, values)))
    .filter((r) => Object.entries(exclude).every(([id, values]) => !excluded(r, id, values)))
    .map((r) => (opts.computed ? { ...r, ...opts.computed(r, exploded) } : r));
  const measure = measures[spec.measure];
  if (!measure) throw new Error(`Unknown measure ${spec.measure}`);
  const rowIds = spec.rows;
  const sets: Array<{ rows: boolean; col: boolean }> = [];
  const hasRows = rowIds.length > 0;
  const hasCol = !!spec.column;
  sets.push({ rows: hasRows, col: hasCol });
  if (hasRows && hasCol) sets.push({ rows: true, col: false }, { rows: false, col: true });
  if (hasRows || hasCol) sets.push({ rows: false, col: false });
  const out: Array<Record<string, unknown>> = [];
  for (const set of sets) {
    const groups = new Map<string, { key: Record<string, unknown>; rs: Rec[] }>();
    for (const r of picked) {
      const key: Record<string, unknown> = {};
      if (set.rows) rowIds.forEach((id, i) => (key[`r${i}`] = val(r, id)));
      if (set.col) key.c = val(r, spec.column!);
      const k = JSON.stringify(key);
      const g = groups.get(k) ?? { key, rs: [] };
      g.rs.push(r);
      groups.set(k, g);
    }
    if (groups.size === 0 && !set.rows && !set.col) groups.set("{}", { key: {}, rs: [] });
    for (const g of groups.values()) {
      out.push({ ...g.key, value: measure(g.rs), g_row: hasRows && !set.rows ? 1 : 0, g_col: hasCol && !set.col ? 1 : 0 });
    }
  }
  out.sort((a, b) => Number(b.g_row) + Number(b.g_col) - (Number(a.g_row) + Number(a.g_col)) || Number(b.value ?? 0) - Number(a.value ?? 0));
  return toReportResult(spec, out);
}
