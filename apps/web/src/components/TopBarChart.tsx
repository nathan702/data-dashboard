import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUsd, formatUsdCompact } from "../lib/format";

interface Props {
  rows: Array<{ key: string; value: number }>;
  color: string;
  valueLabel: string;
}

interface TipProps {
  active?: boolean;
  payload?: Array<{ payload: { key: string; value: number } }>;
  color: string;
  valueLabel: string;
}

function BarTooltip({ active, payload, color, valueLabel }: TipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{p.key}</div>
      <div className="chart-tooltip-row">
        <span className="line-key" style={{ background: color }} aria-hidden />
        <strong>{formatUsd(p.value)}</strong>
        <span className="muted">{valueLabel}</span>
      </div>
    </div>
  );
}

const truncate = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Horizontal bars for a ranked top-N list. Single series, so no legend. */
export function TopBarChart({ rows, color, valueLabel }: Props) {
  if (rows.length === 0) return <div className="empty">No sales in this range.</div>;
  const narrow = typeof window !== "undefined" && window.innerWidth < 600;
  const height = rows.length * 34 + 16;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: narrow ? 56 : 72, bottom: 4, left: 4 }} barCategoryGap={8}>
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            type="category"
            dataKey="key"
            width={narrow ? 112 : 190}
            tickFormatter={(v: string) => truncate(v, narrow ? 16 : 28)}
            tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
            axisLine={{ stroke: "var(--axis)" }}
            tickLine={false}
          />
          <Tooltip content={<BarTooltip color={color} valueLabel={valueLabel} />} cursor={{ fill: "var(--wash)" }} />
          <Bar dataKey="value" fill={color} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: unknown) => formatUsdCompact(Number(v))}
              style={{ fill: "var(--text-secondary)", fontSize: 12 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
