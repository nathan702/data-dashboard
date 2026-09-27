import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  addDays,
  ENROLLMENT_DIMENSION_LABEL,
  ENROLLMENT_DIMENSIONS,
  encodeEnrollmentFilters,
  enrollmentFiltersSchema,
  seasonRange,
  type BusinessLineOrUnassigned,
  type EnrollmentBreakdownRow,
  type EnrollmentDimension,
  type EnrollmentFilters,
  type EnrollmentKpis,
  type EnrollmentSummaryResponse,
} from "@dash/shared";
import { useEnrollmentBreakdown, useEnrollmentMap, useEnrollmentSeasons, useEnrollmentSummary } from "../lib/api";
import { ACCENT_VAR } from "../lib/colors";
import { formatDate, formatInt, formatPercent, percentChange } from "../lib/format";
import { DataTable, type Column } from "./DataTable";
import { TopBarChart } from "./TopBarChart";

// The map library is only downloaded when a page shows the map.
const FamilyMap = lazy(() => import("./FamilyMap"));

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

/** Where a click on a value goes next when drilling down. */
const DRILL_ORDER: EnrollmentDimension[] = ["session_group", "session", "program", "week", "age", "grade", "gender", "years", "state", "status"];

const valueLabel = (d: EnrollmentDimension, v: string) => (d === "week" ? `Week ${v}` : v);

/**
 * Drill-down state in the URL (?cf= filters, ?cdim= breakdown), so a view can
 * be shared and Back steps out of the last drill.
 */
function useDrill() {
  const [params, setParams] = useSearchParams();
  let filters: EnrollmentFilters = {};
  try {
    const parsed = enrollmentFiltersSchema.safeParse(JSON.parse(params.get("cf") ?? "{}"));
    if (parsed.success) filters = parsed.data;
  } catch {
    // Bad link: show everything.
  }
  const cdim = params.get("cdim") as EnrollmentDimension | null;
  const dimension: EnrollmentDimension = cdim && ENROLLMENT_DIMENSIONS.includes(cdim) ? cdim : "session_group";
  const set = (next: { filters?: EnrollmentFilters; dimension?: EnrollmentDimension }, push = false) => {
    const p = new URLSearchParams(params);
    if (next.filters) {
      const enc = encodeEnrollmentFilters(next.filters);
      if (enc) p.set("cf", enc);
      else p.delete("cf");
    }
    if (next.dimension) p.set("cdim", next.dimension);
    setParams(p, { replace: !push });
  };
  const drill = (d: EnrollmentDimension, value: string) => {
    const f = { ...filters, [d]: [value] };
    const nextDim = DRILL_ORDER.slice(DRILL_ORDER.indexOf(d) + 1).find((x) => !f[x]?.length) ?? d;
    set({ filters: f, dimension: nextDim }, true);
  };
  return { filters, dimension, set, drill };
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
  const { filters, dimension, set, drill } = useDrill();
  const setDimension = (d: EnrollmentDimension) => set({ dimension: d });
  const [picking, setPicking] = useState(false);
  const summary = useEnrollmentSummary({ season, businessLine, filters });
  const breakdown = useEnrollmentBreakdown({ season, businessLine, dimension, filters });
  const homes = useEnrollmentMap({ season, businessLine, filters });
  const active = (Object.entries(filters) as Array<[EnrollmentDimension, string[]]>).filter(([, v]) => v.length > 0);

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
    .map((r) => ({ key: valueLabel(dimension, r.key), id: r.key, value: r.enrollments }));
  // Ordered dimensions (weeks, ages, grades) read best in order; others by size.
  const ordered = dimension === "week" || dimension === "age" || dimension === "grade" || dimension === "years";
  const topBars = ordered ? bars : [...bars].sort((a, b) => b.value - a.value).slice(0, 15);

  return (
    <section className="page-section" aria-label={title}>
      {header}
      <div className="chips" aria-label="Filters">
        {active.map(([d, values]) => (
          <span key={d} className="chip">
            <span className="chip-label">{ENROLLMENT_DIMENSION_LABEL[d]}:</span> {values.map((v) => valueLabel(d, v)).join(", ")}
            <button type="button" aria-label={`Remove ${ENROLLMENT_DIMENSION_LABEL[d]} filter`} onClick={() => set({ filters: { ...filters, [d]: [] } }, true)}>
              ×
            </button>
          </span>
        ))}
        <button type="button" className="button" onClick={() => setPicking((x) => !x)} aria-expanded={picking}>
          + Filter
        </button>
        {active.length > 0 && (
          <button type="button" className="link-button" onClick={() => set({ filters: {}, dimension: "session_group" }, true)}>
            Clear filters
          </button>
        )}
        {active.length === 0 && <span className="hint">Click any bar or row to drill in.</span>}
      </div>
      {picking && season !== undefined && (
        <FilterPicker
          season={season}
          businessLine={businessLine}
          filters={filters}
          onApply={(d, values) => {
            set({ filters: { ...filters, [d]: values } }, true);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}
      {summary.error && <div className="error-banner">Couldn't load enrollment stats: {summary.error.message}</div>}
      {s && (
        <>
          <p className="card-subtitle">
            {active.length > 0 ? "Only camper-sessions matching every filter. " : ""}
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
                rows={s.byWeek.map((w) => ({ key: `Week ${w.week}`, id: String(w.week), value: w.enrollments }))}
                color={ACCENT_VAR}
                valueLabel="campers"
                count
                onSelect={(w) => drill("week", w)}
              />
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Where families live</h3>
              {homes.data && (
                <span className="hint">
                  {formatInt(homes.data.points.length)} homes
                  {homes.data.unplaced > 0 && ` · ${formatInt(homes.data.unplaced)} not on the map (address not found)`}
                </span>
              )}
            </div>
            <p className="card-subtitle">
              One dot per home{active.length > 0 ? " with a camper-session matching the filters" : " with an enrolled camper"}; bigger dots have more campers. Click
              the map to zoom with the scroll wheel.
            </p>
            {homes.error && <div className="error-banner">Couldn't load the map: {homes.error.message}</div>}
            <div className={homes.isPlaceholderData ? "refetching" : undefined}>
              <Suspense fallback={<div className="family-map" />}>
                <FamilyMap points={homes.data?.points ?? []} fitKey={`${season}|${businessLine}|${encodeEnrollmentFilters(filters) ?? ""}`} />
              </Suspense>
            </div>
          </div>

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
            <TopBarChart
              rows={topBars}
              color={ACCENT_VAR}
              valueLabel="enrollments"
              count
              emptyText="No enrollments match."
              onSelect={(v) => drill(dimension, v)}
            />
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
          onRowClick={(r) => drill(dimension, r.key)}
          rowTitle="Filter to this and drill in"
        />
      )}
    </section>
  );
}

/** Pick a dimension, then tick values (with counts under the other filters). */
function FilterPicker({
  season,
  businessLine,
  filters,
  onApply,
  onCancel,
}: {
  season: number;
  businessLine?: BusinessLineOrUnassigned;
  filters: EnrollmentFilters;
  onApply(d: EnrollmentDimension, values: string[]): void;
  onCancel(): void;
}) {
  const [dim, setDim] = useState<EnrollmentDimension>("program");
  const [chosen, setChosen] = useState<string[]>(filters[dim] ?? []);
  const [query, setQuery] = useState("");
  // Counts ignore this dimension's own filter, so every option stays visible.
  const others = { ...filters, [dim]: [] };
  const options = useEnrollmentBreakdown({ season, businessLine, dimension: dim, filters: others });
  const q = query.trim().toLowerCase();
  const rows = (options.data?.rows ?? []).filter((r) => !q || valueLabel(dim, r.key).toLowerCase().includes(q));
  const toggle = (v: string) => setChosen((c) => (c.includes(v) ? c.filter((x) => x !== v) : [...c, v]));
  return (
    <div className="card filter-picker">
      <div className="filter-bar">
        <label className="field">
          <span className="field-label">Filter by</span>
          <select
            value={dim}
            onChange={(e) => {
              const d = e.target.value as EnrollmentDimension;
              setDim(d);
              setChosen(filters[d] ?? []);
              setQuery("");
            }}
          >
            {ENROLLMENT_DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {ENROLLMENT_DIMENSION_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Search</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. rafting" />
        </label>
      </div>
      {options.error && <div className="error-banner">Couldn't load values: {options.error.message}</div>}
      <div className="filter-values" role="group" aria-label={`${ENROLLMENT_DIMENSION_LABEL[dim]} values`}>
        {rows.map((r) => (
          <label key={r.key}>
            <input type="checkbox" checked={chosen.includes(r.key)} onChange={() => toggle(r.key)} />
            {valueLabel(dim, r.key)}
            <span className="muted">{formatInt(r.enrollments)}</span>
          </label>
        ))}
        {options.data && rows.length === 0 && <span className="hint">No values match.</span>}
      </div>
      <div className="chips">
        <button type="button" className="button button-primary" onClick={() => onApply(dim, chosen)}>
          Apply
        </button>
        {q && rows.length > 0 && (
          <button type="button" className="link-button" onClick={() => setChosen((c) => [...new Set([...c, ...rows.map((r) => r.key)])])}>
            Select all {rows.length} matching
          </button>
        )}
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
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
