import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BUSINESS_LINE_INFO, type BusinessLine, type Granularity, type RevenueSeriesPoint } from "@dash/shared";
import { LINE_COLOR_VAR } from "../lib/colors";
import { formatPeriod, formatUsd, formatUsdCompact } from "../lib/format";

interface Props {
  series: RevenueSeriesPoint[];
  lines: BusinessLine[];
  granularity: Granularity;
}

type Row = { period: string } & Partial<Record<BusinessLine, number>>;

function pivot(series: RevenueSeriesPoint[], lines: BusinessLine[]): Row[] {
  const byPeriod = new Map<string, Row>();
  for (const p of series) {
    const row = byPeriod.get(p.period) ?? { period: p.period };
    row[p.businessLine] = p.value;
    byPeriod.set(p.period, row);
  }
  // Missing buckets mean no sales, not missing data.
  return [...byPeriod.values()]
    .map((r) => {
      for (const l of lines) r[l] ??= 0;
      return r;
    })
    .sort((a, b) => a.period.localeCompare(b.period));
}

interface TooltipContent {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ dataKey?: string | number; value?: number | string; color?: string }>;
  granularity: Granularity;
}

function ChartTooltip({ active, payload, label, granularity }: TooltipContent) {
  if (!active || !payload?.length) return null;
  const rows = [...payload].sort((a, b) => Number(b.value) - Number(a.value));
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{formatPeriod(String(label), granularity)}</div>
      {rows.map((p) => (
        <div key={String(p.dataKey)} className="chart-tooltip-row">
          <span className="line-key" style={{ background: p.color }} aria-hidden />
          <strong>{formatUsd(Number(p.value))}</strong>
          <span className="muted">{BUSINESS_LINE_INFO[p.dataKey as BusinessLine].label}</span>
        </div>
      ))}
    </div>
  );
}

export function RevenueChart({ series, lines, granularity }: Props) {
  const data = pivot(series, lines);
  if (data.length === 0) return <div className="empty">No revenue in this range.</div>;
  return (
    <figure className="chart">
      {lines.length > 1 && (
        <figcaption className="legend">
          {lines.map((l) => (
            <span key={l} className="legend-item">
              <span className="line-key" style={{ background: LINE_COLOR_VAR[l] }} aria-hidden />
              {BUSINESS_LINE_INFO[l].label}
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
            <Tooltip content={<ChartTooltip granularity={granularity} />} cursor={{ stroke: "var(--axis)", strokeWidth: 1 }} />
            {lines.map((l) => (
              <Line
                key={l}
                type="linear"
                dataKey={l}
                stroke={LINE_COLOR_VAR[l]}
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
