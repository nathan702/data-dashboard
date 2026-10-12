import type { ReactNode } from "react";

/** The active drill-down filters as removable chips, plus "Clear filters". */
export function FilterChips<D extends string>({
  active,
  label,
  valueLabel = (_d, v) => v,
  onRemove,
  onClear,
  children,
}: {
  active: Array<[D, string[]]>;
  label(d: D): string;
  valueLabel?(d: D, v: string): string;
  onRemove(d: D): void;
  onClear(): void;
  /** Extra controls after the chips (e.g. "+ Filter"). */
  children?: ReactNode;
}) {
  return (
    <div className="chips" aria-label="Filters">
      {active.map(([d, values]) => (
        <span key={d} className="chip">
          <span className="chip-label">{label(d)}:</span> {values.map((v) => valueLabel(d, v)).join(", ")}
          <button type="button" aria-label={`Remove ${label(d)} filter`} onClick={() => onRemove(d)}>
            ×
          </button>
        </span>
      ))}
      {children}
      {active.length > 0 && (
        <button type="button" className="link-button" onClick={onClear}>
          Clear filters
        </button>
      )}
      {active.length === 0 && <span className="hint">Click any bar or row to drill in.</span>}
    </div>
  );
}
