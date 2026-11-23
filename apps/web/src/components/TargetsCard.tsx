import { useState } from "react";
import { Link } from "react-router-dom";
import {
  PACE_ALIGNMENT_LABEL,
  TARGET_MEASURE_INFO,
  TARGET_STATUS_LABEL,
  type BusinessLine,
  type TargetProgressRow,
  type TargetStatus,
} from "@dash/shared";
import { useTargetProgress } from "../lib/api";
import { formatDate, formatInt, formatUsd } from "../lib/format";

const STATUS_CLASS: Record<TargetStatus, string> = {
  ahead: "delta-up",
  reached: "delta-up",
  on_track: "delta-flat",
  no_pace: "delta-flat",
  behind: "delta-down",
  missed: "delta-down",
};

const fmt = (row: TargetProgressRow, n: number) => (TARGET_MEASURE_INFO[row.measure].money ? formatUsd(n) : formatInt(Math.round(n)));
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "–");

/** Bar: where the line is now (fill) against the target (full width), with a tick where it should be by now. */
function TargetBar({ row, ended }: { row: TargetProgressRow; ended: boolean }) {
  const now = row.target > 0 ? Math.min(1, row.actual / row.target) : 0;
  const expected = !ended && row.expected !== null && row.target > 0 ? Math.min(1, row.expected / row.target) : null;
  const label = `${pct(row.actual, row.target)} of target${row.expected !== null ? `; ${pct(row.expected, row.target)} expected by now` : ""}`;
  return (
    <div className="target-bar" role="img" aria-label={label} title={label}>
      <div className={`target-bar-fill target-${row.status}`} style={{ width: `${now * 100}%` }} />
      {expected !== null && <div className="target-bar-expected" style={{ left: `${expected * 100}%` }} />}
    </div>
  );
}

/** A business line's targets for one season: where it is, where it should be by now, and whether it's on track. */
export function TargetsCard({ businessLine }: { businessLine: BusinessLine }) {
  const [season, setSeason] = useState<number | undefined>(undefined);
  const { data: d, error, isPlaceholderData } = useTargetProgress(businessLine, season);
  if (error) return <div className="error-banner">Couldn't load targets: {error.message}</div>;
  if (!d || d.season === null || d.rows.length === 0) return null;
  const pace = d.alignedBy && d.samePoint ? `last season's pace at ${PACE_ALIGNMENT_LABEL[d.alignedBy]} (${formatDate(d.samePoint)})` : null;
  return (
    <section className={`card${isPlaceholderData ? " refetching" : ""}`} aria-label="Season targets">
      <div className="card-header">
        <h2 className="card-title">Season {d.season} targets</h2>
        {d.seasons.length > 1 && (
          <label className="field field-inline">
            <span className="field-label">Season</span>
            <select value={d.season} onChange={(e) => setSeason(Number(e.target.value))}>
              {d.seasons.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="card-subtitle">
        {d.range && `${formatDate(d.range.start)} – ${formatDate(d.range.end)}. `}
        {d.ended
          ? "This season is over: final totals against the targets."
          : `Counted through ${formatDate(d.asOf)}, including what's already booked for later in the season. Expected by now follows ${pace ?? "last season's pace"}.`}{" "}
        Set on <Link to="/advanced/settings/targets">Settings → Targets</Link>.
      </p>
      <div className="table-scroll">
        <table className="targets-table">
          <thead>
            <tr>
              <th>Measure</th>
              <th className="num">Target</th>
              <th className="num">{d.ended ? "Final" : "Now"}</th>
              <th className="num">Of target</th>
              {!d.ended && <th className="num">Expected by now</th>}
              <th className="target-progress">Progress</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.measure}>
                <td title={TARGET_MEASURE_INFO[r.measure].help}>{TARGET_MEASURE_INFO[r.measure].label}</td>
                <td className="num">{fmt(r, r.target)}</td>
                <td className="num">{fmt(r, r.actual)}</td>
                <td className="num">{pct(r.actual, r.target)}</td>
                {!d.ended && <td className="num">{r.expected === null ? "–" : fmt(r, r.expected)}</td>}
                <td className="target-progress">
                  <TargetBar row={r} ended={d.ended} />
                </td>
                <td
                  className={STATUS_CLASS[r.status]}
                  title={r.status === "no_pace" ? "Last season has nothing to compare with, so there's no pace to follow." : undefined}
                >
                  {TARGET_STATUS_LABEL[r.status]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
