import type { ComparisonMode, Granularity, RevenueBasis, RevenueMeasure } from "@dash/shared";
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

/** One row of filters above everything they scope. */
export function FilterBar({ filters, onChange }: { filters: Filters; onChange(p: Partial<Filters>): void }) {
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
          <label className="field">
            <span className="field-label">From</span>
            <input type="date" value={filters.start} max={filters.end} onChange={(e) => e.target.value && onChange({ start: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <input type="date" value={filters.end} min={filters.start} onChange={(e) => e.target.value && onChange({ end: e.target.value })} />
          </label>
        </>
      ) : (
        <span className="range-hint">
          {formatDate(filters.start)} – {formatDate(filters.end)}
        </span>
      )}
      <Select label="Count revenue by" value={filters.basis} options={BASIS_LABEL} onChange={(basis) => onChange({ basis })} />
      <Select label="Measure" value={filters.measure} options={MEASURE_LABEL} onChange={(measure) => onChange({ measure })} />
      <Select label="Compare to" value={filters.compare} options={COMPARE_LABEL} onChange={(compare) => onChange({ compare })} />
      <Select label="Chart by" value={filters.granularity} options={GRANULARITY_LABEL} onChange={(granularity) => onChange({ granularity })} />
    </div>
  );
}
