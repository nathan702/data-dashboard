import { Link } from "react-router-dom";
import { formatPercent, formatUsdCompact, percentChange } from "../lib/format";

interface Props {
  label: string;
  value: number;
  previous: number | null;
  comparisonLabel: string | null;
  /** CSS color of the identity swatch beside the label. */
  swatch?: string;
  hero?: boolean;
  /** Makes the whole tile a link (e.g. to the business line's page). */
  href?: string;
}

export function StatTile({ label, value, previous, comparisonLabel, swatch, hero, href }: Props) {
  const change = percentChange(value, previous);
  const direction = change === null ? "flat" : change > 0.0005 ? "up" : change < -0.0005 ? "down" : "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "";
  const body = (
    <>
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
    </>
  );
  const cls = `tile${hero ? " tile-hero" : ""}${href ? " tile-link" : ""}`;
  return href ? (
    <Link to={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
