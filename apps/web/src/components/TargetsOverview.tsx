import { Link, useLocation } from "react-router-dom";
import { BUSINESS_LINE_INFO, TARGET_MEASURE_INFO, TARGET_STATUS_LABEL, type BusinessLine } from "@dash/shared";
import { useTargetsOverview } from "../lib/api";
import { fmt, pct, STATUS_CLASS, TargetBar } from "./TargetsCard";

/** The Overview's targets: every line with targets, on the season its own page opens on, in this person's tab order. */
export function TargetsOverview({ order }: { order: BusinessLine[] }) {
  const { data, error, isPlaceholderData } = useTargetsOverview();
  const { search } = useLocation();
  if (error) return <div className="error-banner">Couldn't load targets: {error.message}</div>;
  if (!data || data.lines.length === 0) return null;
  const rank = (l: BusinessLine) => (order.includes(l) ? order.indexOf(l) : order.length);
  const lines = [...data.lines].sort((a, b) => rank(a.businessLine) - rank(b.businessLine));
  const behind = lines.reduce((n, l) => n + l.rows.filter((r) => r.status === "behind").length, 0);
  return (
    <section className={`card${isPlaceholderData ? " refetching" : ""}`} aria-label="Targets">
      <h2 className="card-title">Targets</h2>
      <p className="card-subtitle">
        Each line's season targets, as on its own page: where it is now and where it would be by now at last season's pace.
        {behind > 0 && ` ${behind} behind.`} Set on <Link to="/advanced/settings/targets">Settings → Targets</Link>; Reports → Targets breaks them down.
      </p>
      <div className="table-scroll">
        <table className="targets-table">
          <thead>
            <tr>
              <th>Business line</th>
              <th>Measure</th>
              <th className="num">Target</th>
              <th className="num">Now</th>
              <th className="num">Of target</th>
              <th className="num">Expected by now</th>
              <th className="target-progress">Progress</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.flatMap((l) =>
              l.rows.map((r, i) => (
                <tr key={`${l.businessLine}-${r.measure}`}>
                  <td>
                    {i === 0 && (
                      <Link to={`/bl/${l.businessLine}${search}`}>
                        {BUSINESS_LINE_INFO[l.businessLine].label} {l.season}
                      </Link>
                    )}
                  </td>
                  <td title={TARGET_MEASURE_INFO[r.measure].help}>{TARGET_MEASURE_INFO[r.measure].label}</td>
                  <td className="num">{fmt(r, r.target)}</td>
                  <td className="num">{fmt(r, r.actual)}</td>
                  <td className="num">{pct(r.actual, r.target)}</td>
                  <td className="num">{l.ended ? "–" : r.expected === null ? "–" : fmt(r, r.expected)}</td>
                  <td className="target-progress">
                    <TargetBar row={r} ended={l.ended} />
                  </td>
                  <td className={STATUS_CLASS[r.status]}>{TARGET_STATUS_LABEL[r.status]}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
