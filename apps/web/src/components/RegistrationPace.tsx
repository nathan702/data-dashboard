import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  addDays,
  DEFAULT_SEASON_SETTINGS,
  easternDate,
  REGISTRATION_WAVE_LABEL,
  REGISTRATION_WAVES,
  type BusinessLineOrUnassigned,
  type EnrollmentFilters,
  type RegistrationWave,
} from "@dash/shared";
import { useRegistrationPace, useSeasonSettings } from "../lib/api";
import { formatInt } from "../lib/format";

/** Seasons shown, newest first; one categorical slot each (see styles.css). */
const MAX_SEASONS = 5;
const SERIES = Array.from({ length: MAX_SEASONS }, (_, i) => `var(--series-${i + 1})`);
/** Days after opening counted: registration through the summer. */
const MAX_DAY = 180;
/** How far the chart reaches: most sign-ups come in the first days, so the first month is the default. */
const RANGES = { week: { label: "First week", days: 7, ticks: [-1, 0, 1, 2, 3, 4, 5, 6, 7] }, month: { label: "First month", days: 30, ticks: [-1, 0, 3, 7, 14, 21, 30] }, season: { label: "Whole season", days: MAX_DAY, ticks: [-1, 14, 28, 56, 84, 112, 140, 168] } } as const;

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Cumulative sign-ups by days since registration opened, one line per season:
 * each family counts from its own wave's opening (returning VA, returning MD,
 * new), so seasons that opened on different dates line up.
 */
export function RegistrationPaceCard({ businessLine, filters }: { businessLine?: BusinessLineOrUnassigned; filters: EnrollmentFilters }) {
  const [wave, setWave] = useState<RegistrationWave | "all">("all");
  const [count, setCount] = useState<"enrollments" | "campers">("enrollments");
  const [range, setRange] = useState<keyof typeof RANGES>("month");
  const pace = useRegistrationPace({ businessLine, filters });
  const opens = (useSeasonSettings().data ?? DEFAULT_SEASON_SETTINGS).registration.opens;
  const today = easternDate();

  const { data, seasons } = useMemo(() => {
    const rows = (pace.data?.rows ?? []).filter((r) => wave === "all" || r.wave === wave);
    const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => b - a).slice(0, MAX_SEASONS);
    const perDay = new Map<string, number>();
    for (const r of rows) perDay.set(`${r.season}|${Math.min(r.day, MAX_DAY)}`, (perDay.get(`${r.season}|${Math.min(r.day, MAX_DAY)}`) ?? 0) + r[count]);
    // A season still under way stops at today (counted from its first opening for all waves).
    const lastDay = (season: number) => {
      const o = opens[String(season)] ?? {};
      const start = wave === "all" ? Object.values(o).sort()[0] : o[wave];
      return start && start <= today ? Math.min(daysBetween(start, today), MAX_DAY) : MAX_DAY;
    };
    const totals = new Map(seasons.map((s) => [s, 0]));
    // Day -1 is "before opening": applications dated before the wave opened.
    const data = Array.from({ length: MAX_DAY + 2 }, (_, i) => {
      const day = i - 1;
      const point: Record<string, number | null> = { day };
      for (const s of seasons) {
        totals.set(s, totals.get(s)! + (perDay.get(`${s}|${day}`) ?? 0));
        point[`s${s}`] = day <= lastDay(s) ? totals.get(s)! : null;
      }
      return point;
    });
    return { data: data.slice(0, RANGES[range].days + 2), seasons };
  }, [pace.data, wave, count, opens, today, range]);

  const openingNote = (season: number) => {
    const o = opens[String(season)] ?? {};
    return wave === "all"
      ? REGISTRATION_WAVES.filter((w) => o[w]).map((w) => `${w === "new" ? "new" : w.toUpperCase()} ${monthDay.format(new Date(`${o[w]}T00:00:00Z`))}`).join(", ")
      : o[wave]
        ? monthDay.format(new Date(`${o[wave]}T00:00:00Z`))
        : "no date set";
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Sign-ups since registration opened</h3>
        <div className="chips">
          <label className="field field-inline">
            <span className="field-label">Families</span>
            <select value={wave} onChange={(e) => setWave(e.target.value as RegistrationWave | "all")}>
              <option value="all">All waves</option>
              {REGISTRATION_WAVES.map((w) => (
                <option key={w} value={w}>
                  {REGISTRATION_WAVE_LABEL[w]}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span className="field-label">Show</span>
            <select value={range} onChange={(e) => setRange(e.target.value as keyof typeof RANGES)}>
              {(Object.keys(RANGES) as Array<keyof typeof RANGES>).map((k) => (
                <option key={k} value={k}>
                  {RANGES[k].label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span className="field-label">Count</span>
            <select value={count} onChange={(e) => setCount(e.target.value as "enrollments" | "campers")}>
              <option value="enrollments">Enrollments</option>
              <option value="campers">Campers</option>
            </select>
          </label>
        </div>
      </div>
      <p className="card-subtitle">
        Day 0 is the day each family's registration opened: returning VA families, returning MD families and new families open on
        different days (Settings → Seasons → Camp registration). Returning = a camper at a camp location last season. “Before” counts
        applications dated before opening; most sign-ups come in the first days, so the first month is shown unless you choose otherwise.
      </p>
      {pace.error && <div className="error-banner">Couldn't load sign-up pace: {pace.error.message}</div>}
      {pace.data && seasons.length === 0 && <div className="empty">No sign-ups in seasons with registration dates set.</div>}
      {seasons.length > 0 && (
        <figure className="chart">
          <figcaption className="legend">
            {seasons.map((s, i) => (
              <span key={s} className="legend-item" title={`Opened ${openingNote(s)}`}>
                <span className="line-key" style={{ background: SERIES[i] }} aria-hidden />
                {s} <span className="muted">({openingNote(s)})</span>
              </span>
            ))}
          </figcaption>
          <div className={`chart-plot${pace.isPlaceholderData ? " refetching" : ""}`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
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
                <YAxis tickFormatter={(v: number) => formatInt(v)} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const day = Number(label);
                    return (
                      <div className="chart-tooltip">
                        <div className="chart-tooltip-title">{day === -1 ? "Before opening" : day === 0 ? "Opening day" : `Day ${day} after opening`}</div>
                        {seasons.map((s, i) => {
                          const v = payload.find((p) => p.dataKey === `s${s}`)?.value;
                          const o = opens[String(s)] ?? {};
                          const start = wave === "all" ? Object.values(o).sort()[0] : o[wave];
                          return v === undefined || v === null ? null : (
                            <div key={s} className="chart-tooltip-row">
                              <span className="line-key" style={{ background: SERIES[i] }} aria-hidden />
                              <strong>{formatInt(Number(v))}</strong>
                              <span className="muted">
                                {s}
                                {start && day >= 0 ? ` · ${monthDay.format(new Date(`${addDays(start, day)}T00:00:00Z`))}` : ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }}
                />
                {seasons.map((s, i) => (
                  <Line
                    key={s}
                    type="linear"
                    dataKey={`s${s}`}
                    stroke={SERIES[i]}
                    strokeWidth={i === 0 ? 3 : 2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </figure>
      )}
    </div>
  );
}
