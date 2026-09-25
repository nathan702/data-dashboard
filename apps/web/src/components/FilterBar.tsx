import { useEffect, useState } from "react";
import { isIsoDate, type ComparisonMode, type Granularity, type RevenueBasis, type RevenueMeasure } from "@dash/shared";
import { PRESETS, type Filters } from "../lib/filters";
import { formatDate } from "../lib/format";

const BASIS_LABEL: Record<RevenueBasis, string> = {
  booked: "Date booked",
  collected: "Date paid",
  service: "Activity / session date",
};
const MEASURE_LABEL: Record<RevenueMeasure, string> = {
  gross: "Gross",
  net: "Net (after discounts & refunds)",
  net_after_fees: "Net after fees",
};
const COMPARE_LABEL: Record<ComparisonMode, string> = {
  previous_year: "Same period last year",
  previous_period: "Previous period",
  none: "No comparison",
};
const GRANULARITY_LABEL: Record<Granularity, string> = { day: "Daily", week: "Weekly", month: "Monthly", season: "By season" };

function Select<T extends string>(props: { label: string; value: T; options: Record<T, string>; onChange(v: T): void }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {(Object.keys(props.options) as T[]).map((k) => (
          <option key={k} value={k}>
            {props.options[k]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Plausible reporting dates only, so a half-typed year like "0002" is never applied. */
export function isUsableDate(v: string): boolean {
  if (!isIsoDate(v)) return false;
  const year = Number(v.slice(0, 4));
  return year >= 2000 && year <= 2100;
}

/**
 * A date box that keeps what's being typed and only applies it once it's a
 * complete, sensible date. Leaving the box with an unusable date restores
 * the last good one.
 */
function DateField({ label, value, onCommit }: { label: string; value: string; onCommit(v: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (isUsableDate(draft) && draft !== value) onCommit(draft);
    else if (!isUsableDate(draft)) setDraft(value);
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="date"
        value={draft}
        min="2000-01-01"
        max="2100-12-31"
        onChange={(e) => {
          setDraft(e.target.value);
          // While a year is being typed the box reports dates like 0002-09-01;
          // those are held as a draft instead of being applied.
          if (isUsableDate(e.target.value)) onCommit(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

/** One row of filters above everything they scope. */
export function FilterBar({
  filters,
  onChange,
  showBasis = true,
}: {
  filters: Filters;
  onChange(p: Partial<Filters>): void;
  /** Hidden where every date basis is the same (retail is paid at purchase). */
  showBasis?: boolean;
}) {
  const presetOptions = Object.fromEntries([...PRESETS.map((p) => [p.id, p.label]), ["custom", "Custom range"]]) as Record<
    Filters["preset"],
    string
  >;
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <Select label="Date range" value={filters.preset} options={presetOptions} onChange={(preset) =>
        onChange(preset === "custom" ? { preset, start: filters.start, end: filters.end } : { preset })
      } />
      {filters.preset === "custom" ? (
        <>
          <DateField label="From" value={filters.start} onCommit={(start) => onChange({ start })} />
          <DateField label="To" value={filters.end} onCommit={(end) => onChange({ end })} />
        </>
      ) : (
        <span className="range-hint">
          {formatDate(filters.start)} – {formatDate(filters.end)}
        </span>
      )}
      {showBasis && (
        <Select label="Count revenue by" value={filters.basis} options={BASIS_LABEL} onChange={(basis) => onChange({ basis })} />
      )}
      <Select label="Measure" value={filters.measure} options={MEASURE_LABEL} onChange={(measure) => onChange({ measure })} />
      <Select label="Compare to" value={filters.compare} options={COMPARE_LABEL} onChange={(compare) => onChange({ compare })} />
      <Select label="Chart by" value={filters.granularity} options={GRANULARITY_LABEL} onChange={(granularity) => onChange({ granularity })} />
    </div>
  );
}
