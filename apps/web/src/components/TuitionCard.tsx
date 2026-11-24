import { extrasPerCamper, tuitionPerCamper, tuitionPerWeek, type BusinessLineOrUnassigned, type CamperTuition, type CamperTuitionResponse, type EnrollmentFilters } from "@dash/shared";
import { useCamperTuition, useCampminderFinance } from "../lib/api";
import { formatDate, formatInt, formatPercent, formatUsd, percentChange } from "../lib/format";

/**
 * A season's tuition, payments and balances from Campminder's Financial
 * report. With the page's filters, only lines for matching camper-sessions.
 */
export function TuitionCard({ season, businessLine, filters }: { season: number | undefined; businessLine?: BusinessLineOrUnassigned; filters: EnrollmentFilters }) {
  const { data: f, error, isPlaceholderData } = useCampminderFinance({ season, businessLine, filters });
  const per = useCamperTuition({ season, businessLine, filters });
  if (error) return <div className="error-banner">Couldn't load tuition and payments: {error.message}</div>;
  if (!f) return null;
  if (f.charges === 0 && f.payments === 0 && !f.filtered) {
    return (
      <div className="card placeholder-card">
        No Campminder transactions for season {f.season} count toward this page. The Financial tab covers the current season; past seasons can be added later.
      </div>
    );
  }
  const tiles: Array<[string, string, string | null]> = [
    ["Net tuition", formatUsd(f.netTuition), `${formatUsd(f.charges)} charged − ${formatUsd(f.discounts)} discounts and credits`],
    ["Collected", formatUsd(f.netCollected), `${formatUsd(f.payments)} paid − ${formatUsd(f.refunds)} refunded`],
    ["Balance owed", formatUsd(f.balanceOwed), `${formatInt(f.householdsOwing)} of ${formatInt(f.households)} households${f.filtered ? ", on these sessions" : ""}`],
    ["Credit held", formatUsd(f.creditHeld), f.filtered ? "Paid more than charged on these sessions" : "Paid more than they owe (refund or carry over)"],
  ];
  return (
    <div className="card">
      <h3 className="card-title">Tuition and payments</h3>
      <p className="card-subtitle">
        {f.filtered
          ? `Season ${f.season}, only the camper-sessions matching the filters: each session's own charges, discounts and the payments split to it. Refunds, unsplit payments and household fees aren't tied to a session, so they're left out.`
          : `Season ${f.season}, from Campminder's Financial report. Report builder → Campminder financials breaks these down.`}
      </p>
      <div className={`tiles${isPlaceholderData ? " refetching" : ""}`}>
        {tiles.map(([label, value, note]) => (
          <div key={label} className="tile tile-small">
            <div className="tile-label">{label}</div>
            <div className="tile-value">{value}</div>
            {note && <div className="tile-delta delta-flat">{note}</div>}
          </div>
        ))}
      </div>
      {per.error && <div className="error-banner">Couldn't load tuition per camper: {per.error.message}</div>}
      {per.data && per.data.current.campers > 0 && <PerCamper r={per.data} refetching={per.isPlaceholderData} />}
    </div>
  );
}

const usd2 = (n: number | null) => (n === null ? "–" : formatUsd(n));

/** Net tuition per camper and per camper-week, and extras per camper, against last season at the same point. */
function PerCamper({ r, refetching }: { r: CamperTuitionResponse; refetching: boolean }) {
  const cmp = r.previous ? `${r.season - 1}${r.previousCutoff ? ` to ${formatDate(r.previousCutoff)}` : ""}` : null;
  const tiles: Array<[string, (t: CamperTuition) => number | null, string]> = [
    ["Net tuition per camper", tuitionPerCamper, `${formatUsd(r.current.tuition)} for ${formatInt(r.current.campers)} campers`],
    ...(r.current.weeks > 0 ? [["Per camper-week", tuitionPerWeek, `${formatInt(r.current.weeks)} camper-weeks`] as [string, (t: CamperTuition) => number | null, string]] : []),
    ...(r.current.extras !== 0 ? [["Extras per camper", extrasPerCamper, `${formatUsd(r.current.extras)} in camp extras`] as [string, (t: CamperTuition) => number | null, string]] : []),
  ];
  return (
    <>
      <p className="card-subtitle" style={{ marginTop: 12 }}>
        Per camper: each enrolled camper's charges less their discounts and credits, extras left out. A discount under a parent is split across the
        household's campers in that session in proportion to their charges.
        {r.filtered
          ? " Only the matching camper-sessions and what was charged to them."
          : r.current.notPerCamper !== 0
            ? ` ${formatUsd(r.current.notPerCamper)} isn't counted per camper (sessions that were cancelled, lines with no camper to give them to).`
            : ""}
        {cmp && ` Compared with ${cmp}.`} Reports → Campers by season breaks it down by age, years at camp, school, siblings…
      </p>
      <div className={`tiles${refetching ? " refetching" : ""}`}>
        {tiles.map(([label, f, note]) => {
          const now = f(r.current);
          const then = r.previous ? f(r.previous) : null;
          const change = now === null ? null : percentChange(now, then);
          const dir = change === null || Math.abs(change) < 0.0005 ? "flat" : change > 0 ? "up" : "down";
          return (
            <div key={label} className="tile tile-small">
              <div className="tile-label">{label}</div>
              <div className="tile-value">{usd2(now)}</div>
              {cmp && then !== null && (
                <div className={`tile-delta delta-${dir}`}>
                  {dir !== "flat" && <span aria-hidden>{dir === "up" ? "▲ " : "▼ "}</span>}
                  {formatPercent(change)} <span className="muted">vs {r.season - 1} ({usd2(then)})</span>
                </div>
              )}
              <div className="tile-delta delta-flat">{note}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
