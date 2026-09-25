import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Granularity, RevenueSeriesPoint } from "@dash/shared";
import { formatPercent, formatPeriod, formatUsd, formatUsdCompact, percentChange } from "../lib/format";

export interface SeriesDef {
  key: string;
  label: string;
  /** CSS color of the line. */
  color: string;
}

interface Props {
  defs: SeriesDef[];
  points: RevenueSeriesPoint[];
  granularity: Granularity;
  /** Drawn only with a single series; already aligned to the current period. */
  comparison?: { points: RevenueSeriesPoint[]; label: string } | null;
}

const CMP_KEY = "__comparison";
type Row = { period: string; [key: string]: number | string | undefined };

function pivot(points: RevenueSeriesPoint[], defs: SeriesDef[], cmp: RevenueSeriesPoint[] | null): Row[] {
  const byPeriod = new Map<string, Row>();
  const add = (period: string, key: string, value: number) => {
    const row = byPeriod.get(period) ?? { period };
    row[key] = ((row[key] as number | undefined) ?? 0) + value;
    byPeriod.set(period, row);
  };
  for (const p of points) add(p.period, p.key, p.value);
  for (const p of cmp ?? []) add(p.period, CMP_KEY, p.value);
  // Missing buckets mean no sales, not missing data.
  return [...byPeriod.values()]
    .map((r) => {
      for (const d of defs) r[d.key] ??= 0;
      if (cmp) r[CMP_KEY] ??= 0;
      return r;
    })
    .sort((a, b) => a.period.localeCompare(b.period));
}

interface TooltipContent {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ dataKey?: string | number; value?: number | string; color?: string }>;
  granularity: Granularity;
  defs: SeriesDef[];
  cmpLabel?: string;
}

function ChartTooltip({ active, payload, label, granularity, defs, cmpLabel }: TooltipContent) {
  if (!active || !payload?.length) return null;
  const labelOf = (k: unknown) => defs.find((d) => d.key === k)?.label ?? String(k);
  const cmp = payload.find((p) => p.dataKey === CMP_KEY);
  if (cmp) {
    const cur = payload.find((p) => p.dataKey !== CMP_KEY);
    const change = percentChange(Number(cur?.value ?? 0), Number(cmp.value));
    return (
      <div className="chart-tooltip">
        <div className="chart-tooltip-title">{formatPeriod(String(label), granularity)}</div>
        <div className="chart-tooltip-row">
          <span className="line-key" style={{ background: cur?.color }} aria-hidden />
          <strong>{formatUsd(Number(cur?.value ?? 0))}</strong>
          <span className="muted">This period</span>
        </div>
        <div className="chart-tooltip-row">
          <span className="line-key" style={{ background: cmp.color }} aria-hidden />
          <strong>{formatUsd(Number(cmp.value))}</strong>
          <span className="muted">{cmpLabel}</span>
        </div>
        <div className="chart-tooltip-row muted">{formatPercent(change)} change</div>
      </div>
    );
  }
  const rows = [...payload].sort((a, b) => Number(b.value) - Number(a.value));
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{formatPeriod(String(label), granularity)}</div>
      {rows.map((p) => (
        <div key={String(p.dataKey)} className="chart-tooltip-row">
          <span className="line-key" style={{ background: p.color }} aria-hidden />
          <strong>{formatUsd(Number(p.value))}</strong>
          <span className="muted">{labelOf(p.dataKey)}</span>
        </div>
      ))}
    </div>
  );
}

export function RevenueChart({ defs, points, granularity, comparison }: Props) {
  const cmp = defs.length === 1 && comparison ? comparison : null;
  const data = pivot(points, defs, cmp?.points ?? null);
  if (data.length === 0) return <div className="empty">No revenue in this range.</div>;
  return (
    <figure className="chart">
      {cmp && (
        <figcaption className="legend">
          <span className="legend-item">
            <span className="line-key" style={{ background: defs[0]!.color }} aria-hidden />
            This period
          </span>
          <span className="legend-item">
            <span className="line-key" style={{ background: "var(--compare)" }} aria-hidden />
            {cmp.label}
          </span>
        </figcaption>
      )}
      {defs.length > 1 && (
        <figcaption className="legend">
          {defs.map((d) => (
            <span key={d.key} className="legend-item">
              <span className="line-key" style={{ background: d.color }} aria-hidden />
              {d.label}
            </span>
          ))}
        </figcaption>
      )}
      <div className="chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis
              dataKey="period"
              tickFormatter={(v: string) => formatPeriod(v, granularity).replace(/, \d{4}$/, "")}
              tick={{ fill: "var(--text-muted)", fontSize: 12 }}
              axisLine={{ stroke: "var(--axis)" }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => formatUsdCompact(v)}
              tick={{ fill: "var(--text-muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip content={<ChartTooltip granularity={granularity} defs={defs} cmpLabel={cmp?.label} />} cursor={{ stroke: "var(--axis)", strokeWidth: 1 }} />
            {cmp && (
              <Line
                type="linear"
                dataKey={CMP_KEY}
                stroke="var(--compare)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                isAnimationActive={false}
              />
            )}
            {defs.map((d) => (
              <Line
                key={d.key}
                type="linear"
                dataKey={d.key}
                stroke={d.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
