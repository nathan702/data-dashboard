import { useMemo, useState, type ReactNode } from "react";
import { downloadCsv, toCsv } from "../lib/csv";

export interface Column<T> {
  key: string;
  label: string;
  /** Raw value used for sorting, filtering and CSV export. */
  value(row: T): string | number | null;
  render?(row: T): ReactNode;
  numeric?: boolean;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey(row: T): string;
  exportName: string;
  searchable?: boolean;
  caption?: string;
}

/** Sortable, filterable table with CSV export. Used for every tabular view. */
export function DataTable<T>({ rows, columns, rowKey, exportName, searchable = true, caption }: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = q
      ? rows.filter((r) => columns.some((c) => String(c.value(r) ?? "").toLowerCase().includes(q)))
      : [...rows];
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        out = out.sort((a, b) => {
          const va = col.value(a);
          const vb = col.value(b);
          if (va === vb) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va < vb ? -1 : 1) * sort.dir;
        });
      }
    }
    return out;
  }, [rows, columns, sort, query]);

  const toggleSort = (key: string, numeric?: boolean) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: numeric ? -1 : 1 }));

  const exportCsv = () => {
    const data = visible.map((r) => Object.fromEntries(columns.map((c) => [c.key, c.value(r)])));
    downloadCsv(`${exportName}.csv`, toCsv(data, columns));
  };

  return (
    <div className="table-card">
      <div className="table-toolbar">
        {caption && <h3 className="table-title">{caption}</h3>}
        <div className="table-actions">
          {searchable && (
            <input
              type="search"
              placeholder="Filter rows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter rows"
            />
          )}
          <button type="button" className="button" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={c.numeric ? "num" : undefined}
                    aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" className="th-button" onClick={() => toggleSort(c.key, c.numeric)}>
                      {c.label}
                      <span className="sort-mark" aria-hidden>
                        {active ? (sort!.dir === 1 ? "↑" : "↓") : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? "num" : undefined}>
                    {c.render ? c.render(r) : c.value(r)}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  No matching rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
