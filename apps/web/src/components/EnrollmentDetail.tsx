import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  addDays,
  ENROLLMENT_DIMENSION_LABEL,
  ENROLLMENT_DIMENSIONS,
  seasonRange,
  type BusinessLineOrUnassigned,
  type EnrollmentBreakdownRow,
  type EnrollmentDimension,
  type EnrollmentKpis,
  type EnrollmentSummaryResponse,
} from "@dash/shared";
import { useEnrollmentBreakdown, useEnrollmentSeasons, useEnrollmentSummary } from "../lib/api";
import { ACCENT_VAR } from "../lib/colors";
import { formatDate, formatInt, formatPercent, percentChange } from "../lib/format";
import { DataTable, type Column } from "./DataTable";
import { TopBarChart } from "./TopBarChart";

const TILES: Array<{ key: keyof EnrollmentKpis; label: string; upIsGood?: boolean }> = [
  { key: "campers", label: "Campers" },
  { key: "enrollments", label: "Enrollments" },
  { key: "newCampers", label: "New campers" },
  { key: "returningCampers", label: "Returning campers" },
  { key: "waitlisted", label: "Waitlisted" },
  { key: "cancelled", label: "Cancelled", upIsGood: false },
  { key: "withdrawn", label: "Withdrawn", upIsGood: false },
];

function CountTile({ label, value, previous, upIsGood = true, cmpLabel }: {
  label: string;
  value: number;
  previous: number | null;
  upIsGood?: boolean;
  cmpLabel: string | null;
}) {
  const change = percentChange(value, previous);
  const dir = change === null || Math.abs(change) < 0.0005 ? "flat" : change > 0 ? "up" : "down";
  const good = dir === "flat" ? "flat" : (dir === "up") === upIsGood ? "up" : "down";
  return (
    <div className="tile tile-small">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{formatInt(value)}</div>
      {cmpLabel && previous !== null && (
        <div className={`tile-delta delta-${good}`}>
          {dir !== "flat" && <span aria-hidden>{dir === "up" ? "▲ " : "▼ "}</span>}
          {formatPercent(change)} <span className="muted">vs {cmpLabel} ({formatInt(previous)})</span>
        </div>
      )}
    </div>
  );
}

/** Which season is shown: ?season= in the URL, else the newest with data. */
function useSeason(available: number[]) {
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get("season"));
  const season = available.includes(requested) ? requested : available[0];
  const setSeason = (s: number) => {
    const next = new URLSearchParams(params);
    next.set("season", String(s));
    setParams(next, { replace: true });
  };
  return [season, setSeason] as const;
}

/**
 * Campminder enrollments for one business line: season KPIs against last
 * season at the same point, campers per week, sign-up pace and breakdowns.
 * Season-based, so the page's date filter doesn't apply.
 */
export function EnrollmentDetail({ businessLine, title = "Enrollment · Campminder" }: { businessLine?: BusinessLineOrUnassigned; title?: string }) {
  const seasons = useEnrollmentSeasons(businessLine);
  const available = (seasons.data?.seasons ?? []).map((s) => s.season);
  const [season, setSeason] = useSeason(available);
  const [dimension, setDimension] = useState<EnrollmentDimension>("session_group");
  const summary = useEnrollmentSummary({ season, businessLine });
  const breakdown = useEnrollmentBreakdown({ season, businessLine, dimension });

  const header = (
    <div className="card-header">
      <h2 className="section-title">{title}</h2>
      {available.length > 0 && (
        <label className="field field-inline">
          <span className="field-label">Season</span>
          <select value={season} onChange={(e) => setSeason(Number(e.target.value))}>
            {available.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );

  if (seasons.error) {
    return (
      <section className="page-section" aria-label={title}>
        {header}
        <div className="error-banner">Couldn't load enrollments: {seasons.error.message}</div>
      </section>
    );
  }
  if (seasons.data && available.length === 0) {
    return (
      <section className="page-section" aria-label={title}>
        {header}
        <div className="card placeholder-card">
          No Campminder enrollments count toward this page yet. Once the sheet has synced, assign its session groups on the Settings page.
        </div>
      </section>
    );
  }

  const s = summary.data;
  const cmpLabel = s?.comparison ? `${(s.season ?? 0) - 1}${seasonOver(s) ? "" : " at this point"}` : null;

  const columns: Column<EnrollmentBreakdownRow>[] = [
    {
      key: "key",
      label: ENROLLMENT_DIMENSION_LABEL[dimension],
      value: (r) => (dimension === "week" ? Number(r.key) : r.key),
      render: (r) => (dimension === "week" ? `Week ${r.key}` : r.key),
    },
    { key: "campers", label: "Campers", numeric: true, value: (r) => r.campers, render: (r) => formatInt(r.campers) },
    { key: "enrollments", label: "Enrollments", numeric: true, value: (r) => r.enrollments, render: (r) => formatInt(r.enrollments) },
    { key: "waitlisted", label: "Waitlisted", numeric: true, value: (r) => r.waitlisted, render: (r) => formatInt(r.waitlisted) },
    { key: "cancelled", label: "Cancelled", numeric: true, value: (r) => r.cancelled, render: (r) => formatInt(r.cancelled) },
    { key: "withdrawn", label: "Withdrawn", numeric: true, value: (r) => r.withdrawn, render: (r) => formatInt(r.withdrawn) },
  ];
  const bars = (breakdown.data?.rows ?? [])
    .filter((r) => r.enrollments > 0)
    .map((r) => ({ key: dimension === "week" ? `Week ${r.key}` : r.key, value: r.enrollments }));
  // Ordered dimensions (weeks, ages, grades) read best in order; others by size.
  const ordered = dimension === "week" || dimension === "age" || dimension === "grade" || dimension === "years";
  const topBars = ordered ? bars : [...bars].sort((a, b) => b.value - a.value).slice(0, 15);

  return (
    <section className="page-section" aria-label={title}>
      {header}
      {summary.error && <div className="error-banner">Couldn't load enrollment stats: {summary.error.message}</div>}
      {s && (
        <>
          <p className="card-subtitle">
            Counts enrolled camper-sessions; each camper counts once in Campers.
            {s.comparison && ` Compared with season ${s.season - 1} ${seasonOver(s) ? "overall" : "at the same point in its season"}.`}
            {!seasonOver(s) && ` As of ${formatDate(s.asOf)}.`}
          </p>
          <div className={`tiles${summary.isPlaceholderData ? " refetching" : ""}`}>
            {TILES.map((t) => (
              <CountTile
                key={t.key}
                label={t.label}
                value={s.current[t.key]}
                previous={s.comparison ? s.comparison[t.key] : null}
                upIsGood={t.upIsGood}
                cmpLabel={cmpLabel}
              />
            ))}
          </div>

          {s.byWeek.length > 0 && (
            <div className="card">
              <h3 className="card-title">Campers per week</h3>
              <p className="card-subtitle">Enrolled in weekly sessions; a multi-week session counts in each of its weeks.</p>
              <TopBarChart
                rows={s.byWeek.map((w) => ({ key: `Week ${w.week}`, value: w.enrollments }))}
                color={ACCENT_VAR}
                valueLabel="campers"
                count
              />
            </div>
          )}

          <div className="card">
            <h3 className="card-title">Sign-up pace</h3>
            <p className="card-subtitle">Total enrollments by application date, season {s.season} against season {s.season - 1}.</p>
            <PaceChart summary={s} />
          </div>
        </>
      )}

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            Enrollments by {ENROLLMENT_DIMENSION_LABEL[dimension].toLowerCase()}
            {!ordered && bars.length > 15 ? " (top 15)" : ""}
          </h3>
          <div className="segmented" role="tablist" aria-label="Break down by">
            {ENROLLMENT_DIMENSIONS.map((d) => (
              <button key={d} type="button" role="tab" aria-selected={d === dimension} onClick={() => setDimension(d)}>
                {ENROLLMENT_DIMENSION_LABEL[d]}
              </button>
            ))}
          </div>
        </div>
        {breakdown.error && <div className="error-banner">Couldn't load breakdown: {breakdown.error.message}</div>}
        {breakdown.data && (
          <div className={breakdown.isPlaceholderData ? "refetching" : undefined}>
            <TopBarChart rows={topBars} color={ACCENT_VAR} valueLabel="enrollments" count emptyText="No enrollments." />
          </div>
        )}
      </div>

      {breakdown.data && (
        <DataTable
          caption={`All ${ENROLLMENT_DIMENSION_LABEL[dimension].toLowerCase()} rows`}
          rows={breakdown.data.rows}
          columns={columns}
          rowKey={(r) => r.key}
          exportName={`campminder${businessLine ? `_${businessLine}` : ""}_${season}_${dimension}`}
        />
      )}
    </section>
  );
}

function seasonOver(s: EnrollmentSummaryResponse) {
  return s.asOf >= seasonRange(s.season).end;
}

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function PaceChart({ summary }: { summary: EnrollmentSummaryResponse }) {
  const start = seasonRange(summary.season).start;
  const label = (w: number) => monthDay.format(new Date(`${addDays(start, w * 7)}T00:00:00Z`));
  if (summary.pace.length === 0) return <div className="empty">No application dates yet.</div>;
  const cur = `Season ${summary.season}`;
  const prev = `Season ${summary.season - 1}`;
  return (
    <figure className="chart">
      <figcaption className="legend">
        <span className="legend-item">
          <span className="line-key" style={{ background: ACCENT_VAR }} aria-hidden />
          {cur}
        </span>
        <span className="legend-item">
          <span className="line-key" style={{ background: "var(--compare)" }} aria-hidden />
          {prev}
        </span>
      </figcaption>
      <div className="chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={summary.pace} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis
              dataKey="weekOfSeason"
              tickFormatter={label}
              tick={{ fill: "var(--text-muted)", fontSize: 12 }}
              axisLine={{ stroke: "var(--axis)" }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => formatInt(v)}
              tick={{ fill: "var(--text-muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              content={({ active, payload, label: w }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]!.payload as EnrollmentSummaryResponse["pace"][number];
                return (
                  <div className="chart-tooltip">
                    <div className="chart-tooltip-title">Week of {label(Number(w))}</div>
                    {row.current !== null && (
                      <div className="chart-tooltip-row">
                        <span className="line-key" style={{ background: ACCENT_VAR }} aria-hidden />
                        <strong>{formatInt(row.current)}</strong>
                        <span className="muted">{cur}</span>
                      </div>
                    )}
                    {row.previous !== null && (
                      <div className="chart-tooltip-row">
                        <span className="line-key" style={{ background: "var(--compare)" }} aria-hidden />
                        <strong>{formatInt(row.previous)}</strong>
                        <span className="muted">{prev}</span>
                      </div>
                    )}
                    {row.current !== null && row.previous ? (
                      <div className="chart-tooltip-row muted">{formatPercent(percentChange(row.current, row.previous))} change</div>
                    ) : null}
                  </div>
                );
              }}
              cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            />
            <Line
              type="linear"
              dataKey="previous"
              stroke="var(--compare)"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="current"
              stroke={ACCENT_VAR}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
