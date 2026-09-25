import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BUSINESS_LINE_INFO, type BusinessLine, type Granularity, type RevenueSeriesPoint } from "@dash/shared";
import { LINE_COLOR_VAR } from "../lib/colors";
import { formatPercent, formatPeriod, formatUsd, formatUsdCompact, percentChange } from "../lib/format";

interface Props {
  series: RevenueSeriesPoint[];
  lines: BusinessLine[];
  granularity: Granularity;
  /** Drawn only for a single business line, already aligned to the current period. */
  comparison?: { series: RevenueSeriesPoint[]; label: string } | null;
}

const CMP_KEY = "__comparison";
type Row = { period: string; [key: string]: number | string | undefined };

function pivot(series: RevenueSeriesPoint[], lines: BusinessLine[], cmp: RevenueSeriesPoint[] | null): Row[] {
  const byPeriod = new Map<string, Row>();
  for (const p of series) {
    const row = byPeriod.get(p.period) ?? { period: p.period };
    row[p.businessLine] = p.value;
    byPeriod.set(p.period, row);
  }
  for (const p of cmp ?? []) {
    const row = byPeriod.get(p.period) ?? { period: p.period };
    row[CMP_KEY] = ((row[CMP_KEY] as number | undefined) ?? 0) + p.value;
    byPeriod.set(p.period, row);
  }
  // Missing buckets mean no sales, not missing data.
  return [...byPeriod.values()]
    .map((r) => {
      for (const l of lines) r[l] ??= 0;
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
  cmpLabel?: string;
}

function ChartTooltip({ active, payload, label, granularity, cmpLabel }: TooltipContent) {
  if (!active || !payload?.length) return null;
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
          <span className="muted">{BUSINESS_LINE_INFO[p.dataKey as BusinessLine].label}</span>
        </div>
      ))}
    </div>
  );
}

export function RevenueChart({ series, lines, granularity, comparison }: Props) {
  const cmp = lines.length === 1 && comparison ? comparison : null;
  const data = pivot(series, lines, cmp?.series ?? null);
  if (data.length === 0) return <div className="empty">No revenue in this range.</div>;
  return (
    <figure className="chart">
      {cmp && (
        <figcaption className="legend">
          <span className="legend-item">
            <span className="line-key" style={{ background: LINE_COLOR_VAR[lines[0]!] }} aria-hidden />
            This period
          </span>
          <span className="legend-item">
            <span className="line-key" style={{ background: "var(--compare)" }} aria-hidden />
            {cmp.label}
          </span>
        </figcaption>
      )}
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
            <Tooltip content={<ChartTooltip granularity={granularity} cmpLabel={cmp?.label} />} cursor={{ stroke: "var(--axis)", strokeWidth: 1 }} />
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
