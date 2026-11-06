import type { BusinessLineOrUnassigned } from "@dash/shared";
import { useCampminderFinance } from "../lib/api";
import { formatInt, formatUsd } from "../lib/format";

/** A season's tuition, payments and balances from Campminder's Financial report. */
export function TuitionCard({ season, businessLine }: { season: number | undefined; businessLine?: BusinessLineOrUnassigned }) {
  const { data: f, error, isPlaceholderData } = useCampminderFinance({ season, businessLine });
  if (error) return <div className="error-banner">Couldn't load tuition and payments: {error.message}</div>;
  if (!f) return null;
  if (f.charges === 0 && f.payments === 0) {
    return (
      <div className="card placeholder-card">
        No Campminder transactions for season {f.season} count toward this page. The Financial tab covers the current season; past seasons can be added later.
      </div>
    );
  }
  const tiles: Array<[string, string, string | null]> = [
    ["Net tuition", formatUsd(f.netTuition), `${formatUsd(f.charges)} charged − ${formatUsd(f.discounts)} discounts and credits`],
    ["Collected", formatUsd(f.netCollected), `${formatUsd(f.payments)} paid − ${formatUsd(f.refunds)} refunded`],
    ["Balance owed", formatUsd(f.balanceOwed), `${formatInt(f.householdsOwing)} of ${formatInt(f.households)} households`],
    ["Credit held", formatUsd(f.creditHeld), "Paid more than they owe (refund or carry over)"],
  ];
  return (
    <div className="card">
      <h3 className="card-title">Tuition and payments</h3>
      <p className="card-subtitle">
        Season {f.season}, from Campminder's Financial report. The filters above don't apply. Report builder → Campminder financials breaks these down.
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
    </div>
  );
}
