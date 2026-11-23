import { useMemo, useState, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  daysUntil,
  filterReturning,
  RETURNING_SEGMENT_LABEL,
  RETURNING_SEGMENT_ORDER,
  RETURNING_SEGMENTS,
  RETURNING_STATUS_LABEL,
  RETURNING_WAVE_LABEL,
  returningCurve,
  returningSegmentKey,
  returningSummary,
  share,
  type CampLocation,
  type RegistrationSettings,
  type ReturningFamily,
  type ReturningFilters,
  type ReturningResponse,
  type ReturningSegment,
} from "@dash/shared";
import { useReturningFamilies } from "../lib/api";
import { formatDate, formatInt } from "../lib/format";
import { DataTable, type Column } from "./DataTable";
import { FilterChips } from "./FilterChips";

const UNKNOWN = "(unknown)";
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const RANGES = { month: { label: "First month", days: 30, ticks: [-1, 0, 7, 14, 21, 30] }, season: { label: "Whole season", days: 180, ticks: [-1, 14, 28, 56, 84, 112, 140, 168] } } as const;

const pct = (p: number | null) => (p === null ? "–" : `${Math.round(p * 100)}%`);
/** Percentage points between two shares, e.g. "▲ 4 pts". */
function PointsDelta({ now, then, label }: { now: number | null; then: number | null; label: string }) {
  if (now === null || then === null) return null;
  const pts = Math.round((now - then) * 100);
  const dir = pts === 0 ? "flat" : pts > 0 ? "up" : "down";
  return (
    <div className={`tile-delta delta-${dir}`}>
      {dir !== "flat" && <span aria-hidden>{dir === "up" ? "▲ " : "▼ "}</span>}
      {pts === 0 ? "same" : `${Math.abs(pts)} pts`} <span className="muted">vs {label} ({pct(then)})</span>
    </div>
  );
}

function Tile({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="tile tile-small">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {children}
    </div>
  );
}

interface SegmentRow {
  key: string;
  families: number;
  enrolled: number;
  share: number | null;
  lastYear: number | null;
  notYet: number;
  waitlisted: number;
  cancelled: number;
}

/**
 * Camp's returning families: households with a camper at a camp location last
 * season, and whether they've signed up again. Tiles against last season at
 * the same point, the share re-enrolled by days since each family's wave
 * opened, and who's still to come back by segment (click to filter).
 * Its own season and filters: the page's drill-down filters don't apply.
 */
export function ReturningFamiliesCard() {
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const q = useReturningFamilies(picked);
  const [wave, setWave] = useState<CampLocation | "all">("all");
  const [filters, setFilters] = useState<ReturningFilters>({});
  const [dimension, setDimension] = useState<ReturningSegment>("session_group");
  const [range, setRange] = useState<keyof typeof RANGES>("month");
  const r = q.data;

  const view = useMemo(() => (r ? buildView(r, wave, filters, dimension, range) : null), [r, wave, filters, dimension, range]);
  const active = Object.entries(filters).filter(([, v]) => v && v.length) as Array<[ReturningSegment, string[]]>;
  const addFilter = (d: ReturningSegment, v: string) => {
    setFilters((f) => ({ ...f, [d]: [v] }));
    const next = RETURNING_SEGMENTS.find((x) => x !== d && x !== "status" && !filters[x]);
    if (next) setDimension(next);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Returning families</h3>
        {r && r.seasons.length > 0 && (
          <div className="chips">
            <label className="field field-inline">
              <span className="field-label">Season</span>
              <select value={r.season} onChange={(e) => setPicked(Number(e.target.value))}>
                {r.seasons.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-inline">
              <span className="field-label">Wave</span>
              <select value={wave} onChange={(e) => setWave(e.target.value as CampLocation | "all")}>
                <option value="all">Both waves</option>
                <option value="va">{RETURNING_WAVE_LABEL.va}</option>
                <option value="md">{RETURNING_WAVE_LABEL.md}</option>
              </select>
            </label>
          </div>
        )}
      </div>
      {q.error && <div className="error-banner">Couldn't load returning families: {q.error.message}</div>}
      {r && r.seasons.length === 0 && <div className="empty">No families at a camp location yet (Settings → Seasons → Camp registration lists the locations).</div>}
      {r && view && r.seasons.length > 0 && (
        <div className={q.isPlaceholderData ? "refetching" : undefined}>
          <p className="card-subtitle">
            Families with a camper at a camp location in {r.season - 1} (Settings → Seasons → Camp registration), and whether they've signed up
            for Camp in {r.season}. A family counts as re-enrolled when any of its campers is enrolled, a new sibling too. Families whose{" "}
            {r.season - 1} campers are all too old for Camp now have aged out (over {r.ageOutAfter[String(r.season)] ?? "–"} on June 1
            {r.ageOutSet ? ", set on Settings → Seasons" : ", the oldest age last summer; changeable on Settings → Seasons"}) and aren't in the
            percentages. Names are never shown: pull the families themselves from Campminder. The page's filters don't apply here.
          </p>
          {view.note && <p className="hint">{view.note}</p>}
          <FilterChips
            active={active}
            label={(d) => RETURNING_SEGMENT_LABEL[d]}
            onRemove={(d) => setFilters((f) => ({ ...f, [d]: [] }))}
            onClear={() => setFilters({})}
          />
          <div className="tiles">
            <Tile label="Returning families" value={formatInt(view.cur.families)} />
            <Tile label="Re-enrolled" value={`${formatInt(view.cur.enrolled)} · ${pct(view.share)}`}>
              <PointsDelta now={view.share} then={view.lastShare} label={r.asOf.over ? `${r.season - 1} overall` : `${r.season - 1} at this point`} />
            </Tile>
            <Tile label="Not yet" value={formatInt(view.cur.notYet)} />
            <Tile label={RETURNING_STATUS_LABEL.waitlisted} value={formatInt(view.cur.waitlisted)} />
            <Tile label={RETURNING_STATUS_LABEL.cancelled} value={formatInt(view.cur.cancelled)} />
            <Tile label="Returning campers re-enrolled" value={`${formatInt(view.cur.reenrolledCampers)} of ${formatInt(view.cur.eligibleCampers)}`} />
            <Tile label="Aged out" value={formatInt(view.cur.agedOut)} />
            {view.lastFinal !== null && <Tile label={`${r.season - 1} in the end`} value={pct(view.lastFinal)} />}
          </div>

          <div className="card-header" style={{ marginTop: 16 }}>
            <h4 className="card-title">Share re-enrolled since registration opened</h4>
            <div className="segmented" role="tablist" aria-label="Chart range">
              {(Object.keys(RANGES) as Array<keyof typeof RANGES>).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={k === range} onClick={() => setRange(k)}>
                  {RANGES[k].label}
                </button>
              ))}
            </div>
          </div>
          {view.seasons.length === 0 ? (
            <div className="empty">No registration opening dates for these seasons (Settings → Seasons → Camp registration).</div>
          ) : (
            <figure className="chart">
              <figcaption className="legend">
                {view.seasons.map((s, i) => (
                  <span key={s} className="legend-item">
                    <span className="line-key" style={{ background: SERIES[i] }} aria-hidden />
                    {s}
                  </span>
                ))}
              </figcaption>
              <div className="chart-plot">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={view.curve} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
                    <XAxis
                      dataKey="day"
                      type="number"
                      domain={[-1, RANGES[range].days]}
                      ticks={[...RANGES[range].ticks]}
                      tickFormatter={(d: number) => (d === -1 ? "Before" : d === 0 ? "Opening day" : `Day ${d}`)}
                      tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                      axisLine={{ stroke: "var(--axis)" }}
                      tickLine={false}
                    />
                    <YAxis domain={[0, 1]} tickFormatter={(v: number) => pct(v)} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={48} />
                    <Tooltip
                      content={({ active: on, payload, label }) => {
                        if (!on || !payload?.length) return null;
                        const day = Number(label);
                        return (
                          <div className="chart-tooltip">
                            <div className="chart-tooltip-title">{day === -1 ? "Before opening" : day === 0 ? "Opening day" : `Day ${day} after opening`}</div>
                            {view.seasons.map((s, i) => {
                              const v = payload.find((p) => p.dataKey === String(s))?.value;
                              return v === undefined || v === null ? null : (
                                <div key={s} className="chart-tooltip-row">
                                  <span className="line-key" style={{ background: SERIES[i] }} aria-hidden />
                                  <strong>{pct(Number(v))}</strong>
                                  <span className="muted">{s}</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      }}
                    />
                    {view.seasons.map((s, i) => (
                      <Line key={s} type="linear" dataKey={String(s)} stroke={SERIES[i]} strokeWidth={i === 0 ? 3 : 2} dot={false} connectNulls={false} isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </figure>
          )}

          <div className="card-header" style={{ marginTop: 16 }}>
            <h4 className="card-title">By {RETURNING_SEGMENT_LABEL[dimension].toLowerCase()}</h4>
            <div className="segmented" role="tablist" aria-label="Break down by">
              {RETURNING_SEGMENTS.map((d) => (
                <button key={d} type="button" role="tab" aria-selected={d === dimension} onClick={() => setDimension(d)}>
                  {RETURNING_SEGMENT_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
          <DataTable
            rows={view.segments}
            columns={segmentColumns(dimension, r.asOf.over ? `${r.season - 1} overall` : `${r.season - 1} at this point`)}
            rowKey={(x) => x.key}
            exportName={`returning_families_${r.season}_${dimension}`}
            searchable={false}
            onRowClick={(x) => addFilter(dimension, x.key)}
            rowTitle="Filter to this"
          />
        </div>
      )}
    </div>
  );
}

function segmentColumns(d: ReturningSegment, lastLabel: string): Column<SegmentRow>[] {
  return [
    { key: "key", label: RETURNING_SEGMENT_LABEL[d], value: (x) => x.key },
    { key: "families", label: "Families", numeric: true, value: (x) => x.families, render: (x) => formatInt(x.families) },
    { key: "enrolled", label: "Re-enrolled", numeric: true, value: (x) => x.enrolled, render: (x) => formatInt(x.enrolled) },
    { key: "share", label: "% re-enrolled", numeric: true, value: (x) => x.share, render: (x) => pct(x.share) },
    { key: "lastYear", label: lastLabel, numeric: true, value: (x) => x.lastYear, render: (x) => pct(x.lastYear) },
    { key: "notYet", label: "Not yet", numeric: true, value: (x) => x.notYet, render: (x) => formatInt(x.notYet) },
    { key: "waitlisted", label: "Waitlisted or applied", numeric: true, value: (x) => x.waitlisted, render: (x) => formatInt(x.waitlisted) },
    { key: "cancelled", label: "Cancelled", numeric: true, value: (x) => x.cancelled, render: (x) => formatInt(x.cancelled) },
  ];
}

/** Everything the card shows, from the families, the wave and the filters (all worked out in @dash/shared). */
function buildView(r: ReturningResponse, wave: CampLocation | "all", filters: ReturningFilters, dimension: ReturningSegment, range: keyof typeof RANGES) {
  const registration: RegistrationSettings = { opens: r.opens, locations: {}, ageOutAfter: null };
  const inWave = (fs: ReturningFamily[]) => (wave === "all" ? fs : fs.filter((f) => f.wave === wave));
  const fams = filterReturning(inWave(r.families), filters, UNKNOWN);
  const summary = returningSummary(fams, r.season, registration, r.asOf);
  const prev = summary.previous;

  const seasons = [r.season, r.season - 1, r.season - 2].filter((s) => r.opens[String(s)] && fams.some((f) => f.season === s));
  const curve = returningCurve(fams, seasons, registration, { ...r.asOf, season: r.season }, RANGES[range].days);

  const cur = fams.filter((f) => f.season === r.season);
  const groups = new Map<string, ReturningFamily[]>();
  for (const f of cur) {
    const k = returningSegmentKey(f, dimension) ?? UNKNOWN;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const order = RETURNING_SEGMENT_ORDER[dimension];
  const segments: SegmentRow[] = [...groups.keys()].map((key) => {
    const s = returningSummary(filterReturning(fams, { [dimension]: [key] }, UNKNOWN), r.season, registration, r.asOf);
    return {
      key,
      families: s.current.families,
      enrolled: s.current.enrolled,
      share: share(s.current.enrolled, s.current.families),
      lastYear: s.previous ? share(s.previous.samePoint, s.previous.families) : null,
      notYet: s.current.notYet,
      waitlisted: s.current.waitlisted,
      cancelled: s.current.cancelled,
    };
  });
  segments.sort((a, b) => (order ? order.indexOf(a.key) - order.indexOf(b.key) : b.families - a.families || a.key.localeCompare(b.key)));

  // Where registration is: not open yet, no dates set, or under way.
  const o = r.opens[String(r.season)];
  const first = [o?.va, o?.md].filter((d): d is string => !!d).sort()[0];
  const note = r.asOf.over
    ? null
    : !first
      ? `${r.season} registration dates aren't set (Settings → Seasons → Camp registration): until they are, last season is compared on the same date a year earlier.`
      : daysUntil(r.asOf.today, first) > 0
        ? `${r.season} registration opens ${formatDate(first)}, in ${daysUntil(r.asOf.today, first)} days.`
        : null;

  return {
    cur: summary.current,
    share: share(summary.current.enrolled, summary.current.families),
    lastShare: prev ? share(prev.samePoint, prev.families) : null,
    lastFinal: prev ? share(prev.final, prev.families) : null,
    seasons,
    curve,
    segments,
    note,
  };
}
