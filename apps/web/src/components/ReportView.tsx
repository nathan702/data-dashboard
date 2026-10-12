import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ReportChart } from "@dash/shared";
import { ACCENT_VAR } from "../lib/colors";
import { downloadCsv, toCsv } from "../lib/csv";
import { displayValue, formatMeasure, type Pivot } from "../lib/pivot";
import { TopBarChart } from "./TopBarChart";

/** Categorical slots in fixed order (validated set; see styles.css). More than eight → table. */
const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const MAX_SERIES = SERIES.length;
const MAX_CHART_ROWS = 40;

interface Props {
  pivot: Pivot;
  chart: ReportChart;
  /** Click a cell: filter to its row values (and column value). */
  onDrill(row: string[] | null, col: string | null): void;
  exportName: string;
}

export function ReportView({ pivot, chart, onDrill, exportName }: Props) {
  const fmt = (v: number | null) => formatMeasure(v, pivot.percent ? "share" : pivot.measure.format);
  const rowLabel = (row: string[]) => row.map((v, i) => displayValue(pivot.rowFields[i]!, v)).join(" · ");
  const colLabel = (c: string) => displayValue(pivot.colField, c);

  const exportCsv = () => {
    const cols = [
      ...pivot.rowFields.map((f, i) => ({ key: `r${i}`, label: f.label })),
      ...(pivot.colField ? pivot.colKeys.map((c, i) => ({ key: `c${i}`, label: colLabel(c) })) : []),
      { key: "total", label: pivot.colField ? "Total" : pivot.measure.label },
    ];
    const rows = pivot.rowKeys.map((rk) => {
      const out: Record<string, string | number | null> = {};
      rk.forEach((v, i) => (out[`r${i}`] = displayValue(pivot.rowFields[i]!, v)));
      pivot.colKeys.forEach((c, i) => (out[`c${i}`] = pivot.shown(pivot.value(rk, c), rk, c)));
      out.total = pivot.shown(pivot.rowTotal(rk), rk, null);
      return out;
    });
    downloadCsv(`${exportName}.csv`, toCsv(rows, cols));
  };

  let body: React.ReactNode;
  let note: string | null = null;
  const tooMany = pivot.colKeys.length > MAX_SERIES;
  if (chart === "bar" && pivot.rowKeys.length > 0 && !tooMany && pivot.rowKeys.length <= MAX_CHART_ROWS) {
    body = pivot.colField ? <GroupedBars pivot={pivot} fmt={fmt} rowLabel={rowLabel} colLabel={colLabel} /> : (
      <TopBarChart
        rows={pivot.rowKeys.map((rk) => ({ key: rowLabel(rk), id: JSON.stringify(rk), value: pivot.shown(pivot.rowTotal(rk), rk, null) ?? 0 }))}
        color={ACCENT_VAR}
        valueLabel={pivot.percent ? "share" : pivot.measure.label.toLowerCase()}
        format={(n) => fmt(n)}
        emptyText="Nothing matches."
        onSelect={(id) => onDrill(JSON.parse(id) as string[], null)}
      />
    );
  } else if (chart === "line" && pivot.rowFields.length === 1 && pivot.rowFields[0]!.order !== "text" && !tooMany && pivot.rowKeys.length > 1) {
    body = <Lines pivot={pivot} fmt={fmt} colLabel={colLabel} />;
  } else {
    if (chart === "bar" || chart === "line") {
      note = tooMany
        ? `More than ${MAX_SERIES} columns is too many to chart clearly, so this shows the table. Filter the column field to chart it.`
        : chart === "line"
          ? "A line chart needs one ordered field down the side (season, week, age, month…), so this shows the table."
          : `More than ${MAX_CHART_ROWS} rows is too many to chart clearly, so this shows the table.`;
    }
    body = <PivotTable pivot={pivot} fmt={fmt} heat={chart === "heatmap"} onDrill={onDrill} rowLabel={rowLabel} colLabel={colLabel} />;
  }

  return (
    <div className="report-view">
      <div className="report-view-actions">
        <span className="hint">Click a row, bar or cell to filter to it.</span>
        <button type="button" className="button" onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      {note && <p className="hint">{note}</p>}
      {body}
      {chart !== "table" && chart !== "heatmap" && !note && (
        <details className="report-table-details">
          <summary>Show as a table</summary>
          <PivotTable pivot={pivot} fmt={fmt} heat={false} onDrill={onDrill} rowLabel={rowLabel} colLabel={colLabel} />
        </details>
      )}
    </div>
  );
}

function PivotTable({
  pivot,
  fmt,
  heat,
  onDrill,
  colLabel,
}: {
  pivot: Pivot;
  fmt(v: number | null): string;
  heat: boolean;
  onDrill(row: string[] | null, col: string | null): void;
  rowLabel(row: string[]): string;
  colLabel(c: string): string;
}) {
  const cols = pivot.colField ? pivot.colKeys : [];
  // Heat map: one-hue ramp from the surface to the accent, scaled to the largest cell shown.
  const shownCells = pivot.rowKeys.flatMap((rk) => (cols.length ? cols.map((c) => pivot.shown(pivot.value(rk, c), rk, c)) : [pivot.shown(pivot.rowTotal(rk), rk, null)]));
  const max = Math.max(0, ...shownCells.map((v) => v ?? 0));
  const shade = (v: number | null) => {
    if (!heat || v === null || max <= 0) return undefined;
    const pct = Math.round(8 + 82 * (v / max));
    return { background: `color-mix(in oklab, var(--accent) ${pct}%, var(--surface))`, color: pct > 55 ? "#ffffff" : undefined };
  };
  return (
    <div className="table-card">
      <div className="table-scroll">
        <table className={`pivot${heat ? " pivot-heat" : ""}`}>
          <thead>
            <tr>
              {pivot.rowFields.map((f) => (
                <th key={f.id}>{f.label}</th>
              ))}
              {cols.map((c) => (
                <th key={c} className="num">
                  {colLabel(c)}
                </th>
              ))}
              <th className="num">{pivot.colField ? "Total" : pivot.percent ? "Share" : pivot.measure.label}</th>
            </tr>
          </thead>
          <tbody>
            {pivot.rowKeys.map((rk) => (
              <tr key={rk.join("|")}>
                {rk.map((v, i) => (
                  <td key={i}>
                    <button type="button" className="cell-link" onClick={() => onDrill(rk, null)} title="Filter to this row">
                      {displayValue(pivot.rowFields[i]!, v)}
                    </button>
                  </td>
                ))}
                {cols.map((c) => {
                  const v = pivot.shown(pivot.value(rk, c), rk, c);
                  return (
                    <td key={c} className="num" style={shade(v)}>
                      {v === null ? (
                        <span className="muted">–</span>
                      ) : (
                        <button type="button" className="cell-link" onClick={() => onDrill(rk, c)} title="Filter to this cell">
                          {fmt(v)}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="num total-cell" style={cols.length ? undefined : shade(pivot.shown(pivot.rowTotal(rk), rk, null))}>
                  {fmt(pivot.shown(pivot.rowTotal(rk), rk, null))}
                </td>
              </tr>
            ))}
            {pivot.rowKeys.length === 0 && (
              <tr>
                <td colSpan={pivot.rowFields.length + cols.length + 1} className="empty">
                  {pivot.total === null ? "Nothing matches these filters." : ""}
                </td>
              </tr>
            )}
          </tbody>
          {(pivot.rowFields.length > 0 || cols.length > 0) && (
            <tfoot>
              <tr>
                {pivot.rowFields.length > 0 && <td colSpan={pivot.rowFields.length}>Total</td>}
                {cols.map((c) => (
                  <td key={c} className="num">
                    {fmt(pivot.shown(pivot.colTotal(c), null, c))}
                  </td>
                ))}
                <td className="num">{fmt(pivot.percent ? 1 : pivot.total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function SeriesLegend({ keys, colLabel }: { keys: string[]; colLabel(c: string): string }) {
  return (
    <figcaption className="legend">
      {keys.map((c, i) => (
        <span key={c} className="legend-item">
          <span className="swatch" style={{ background: SERIES[i] }} aria-hidden />
          {colLabel(c)}
        </span>
      ))}
    </figcaption>
  );
}

function ChartTip({ active, payload, label, fmt }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string; fmt(v: number | null): string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="chart-tooltip-row">
          <span className="line-key" style={{ background: p.color }} aria-hidden />
          <strong>{fmt(p.value ?? null)}</strong>
          <span className="muted">{p.name}</span>
        </div>
      ))}
    </div>
  );
}

function GroupedBars({ pivot, fmt, rowLabel, colLabel }: { pivot: Pivot; fmt(v: number | null): string; rowLabel(r: string[]): string; colLabel(c: string): string }) {
  const data = pivot.rowKeys.map((rk) => {
    const d: Record<string, string | number | null> = { label: rowLabel(rk) };
    pivot.colKeys.forEach((c) => (d[colLabel(c)] = pivot.shown(pivot.value(rk, c), rk, c)));
    return d;
  });
  // Text categories (programs, ZIPs…) read better as horizontal bars with labels down the side;
  // ordered ones (season, week, age) keep their order left to right.
  const horizontal = pivot.rowFields.some((f) => f.order === "text");
  const narrow = typeof window !== "undefined" && window.innerWidth < 600;
  const tick = { fill: "var(--text-muted)", fontSize: 12 };
  const height = horizontal ? Math.max(200, data.length * Math.max(pivot.colKeys.length * 14 + 18, narrow ? 56 : 44) + 40) : undefined;
  return (
    <figure className="chart">
      <SeriesLegend keys={pivot.colKeys} colLabel={colLabel} />
      <div className={horizontal ? undefined : "chart-plot"} style={horizontal ? { height } : undefined}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout={horizontal ? "vertical" : "horizontal"}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            barGap={2}
            barCategoryGap={horizontal ? 8 : "20%"}
          >
            <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--grid)" />
            {horizontal ? (
              <>
                <XAxis type="number" tickFormatter={(v: number) => fmt(v)} tick={tick} axisLine={false} tickLine={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={narrow ? 130 : 260}
                  tick={tick}
                  axisLine={{ stroke: "var(--axis)" }}
                  tickLine={false}
                  // Labels wrap onto extra lines; only very long ones are cut (the tooltip has the full name).
                  tickFormatter={(v: string) => (v.length > (narrow ? 48 : 80) ? `${v.slice(0, narrow ? 47 : 79)}…` : v)}
                />
              </>
            ) : (
              <>
                <XAxis dataKey="label" tick={tick} axisLine={{ stroke: "var(--axis)" }} tickLine={false} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v: number) => fmt(v)} tick={tick} axisLine={false} tickLine={false} width={64} />
              </>
            )}
            <Tooltip content={<ChartTip fmt={fmt} />} cursor={{ fill: "var(--wash)" }} />
            {pivot.colKeys.map((c, i) => (
              <Bar key={c} dataKey={colLabel(c)} fill={SERIES[i]} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function Lines({ pivot, fmt, colLabel }: { pivot: Pivot; fmt(v: number | null): string; colLabel(c: string): string }) {
  const field = pivot.rowFields[0]!;
  const series = pivot.colField ? pivot.colKeys : [];
  const data = pivot.rowKeys.map((rk) => {
    const d: Record<string, string | number | null> = { label: displayValue(field, rk[0]!) };
    if (series.length) series.forEach((c) => (d[colLabel(c)] = pivot.shown(pivot.value(rk, c), rk, c)));
    else d[pivot.measure.label] = pivot.shown(pivot.rowTotal(rk), rk, null);
    return d;
  });
  const keys = series.length ? series.map(colLabel) : [pivot.measure.label];
  return (
    <figure className="chart">
      {series.length > 0 && <SeriesLegend keys={series} colLabel={colLabel} />}
      <div className="chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={{ stroke: "var(--axis)" }} tickLine={false} minTickGap={16} />
            <YAxis tickFormatter={(v: number) => fmt(v)} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={64} />
            <Tooltip content={<ChartTip fmt={fmt} />} cursor={{ stroke: "var(--axis)", strokeWidth: 1 }} />
            {keys.map((key, i) => (
              <Line
                key={key}
                type="linear"
                dataKey={key}
                stroke={series.length ? SERIES[i] : ACCENT_VAR}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--surface)" }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
