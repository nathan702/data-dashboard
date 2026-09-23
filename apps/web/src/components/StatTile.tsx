import { formatPercent, formatUsdCompact, percentChange } from "../lib/format";

interface Props {
  label: string;
  value: number;
  previous: number | null;
  comparisonLabel: string | null;
  /** CSS color of the identity swatch beside the label. */
  swatch?: string;
  hero?: boolean;
}

export function StatTile({ label, value, previous, comparisonLabel, swatch, hero }: Props) {
  const change = percentChange(value, previous);
  const direction = change === null ? "flat" : change > 0.0005 ? "up" : change < -0.0005 ? "down" : "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "";
  return (
    <div className={`tile${hero ? " tile-hero" : ""}`}>
      <div className="tile-label">
        {swatch && <span className="swatch" style={{ background: swatch }} aria-hidden />}
        {label}
      </div>
      <div className="tile-value">{formatUsdCompact(value)}</div>
      {comparisonLabel && (
        <div className={`tile-delta delta-${direction}`}>
          {arrow && <span aria-hidden>{arrow} </span>}
          {formatPercent(change)} <span className="muted">vs {comparisonLabel}</span>
        </div>
      )}
    </div>
  );
}
