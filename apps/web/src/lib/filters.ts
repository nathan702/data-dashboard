import { useSearchParams } from "react-router-dom";
import {
  daysBetweenInclusive,
  GRANULARITIES,
  isIsoDate,
  presetRange,
  REVENUE_BASES,
  REVENUE_MEASURES,
  type ComparisonMode,
  type DatePreset,
  type Granularity,
  type RevenueBasis,
  type RevenueMeasure,
} from "@dash/shared";

export const PRESETS: Array<{ id: DatePreset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last_7_days", label: "Last 7 days" },
  { id: "last_30_days", label: "Last 30 days" },
  { id: "month_to_date", label: "Month to date" },
  { id: "year_to_date", label: "Year to date" },
  { id: "season_to_date", label: "Season to date" },
  { id: "last_season", label: "Last season" },
];

export interface Filters {
  preset: DatePreset | "custom";
  start: string;
  end: string;
  basis: RevenueBasis;
  measure: RevenueMeasure;
  compare: ComparisonMode;
  granularity: Granularity;
}

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Sensible bucket size for a range, so charts never have thousands of points. */
export function autoGranularity(start: string, end: string): Granularity {
  const days = daysBetweenInclusive(start, end);
  if (days <= 62) return "day";
  if (days <= 400) return "week";
  return "month";
}

/**
 * Filters live in the URL, so a filtered view can be bookmarked or pasted
 * to a colleague and they see exactly the same numbers.
 */
export function useFilters(): [Filters, (patch: Partial<Filters>) => void] {
  const [params, setParams] = useSearchParams();
  const presetParam = params.get("range");
  // A custom range stays custom even while its dates are being edited;
  // missing or invalid dates fall back to the last 30 days.
  const isCustom = presetParam === "custom";
  const preset: Filters["preset"] = isCustom ? "custom" : pick(presetParam, PRESETS.map((p) => p.id), "last_30_days");
  let range = presetRange(isCustom ? "last_30_days" : (preset as DatePreset));
  if (isCustom) {
    const s = params.get("start");
    const e = params.get("end");
    const start = s && isIsoDate(s) ? s : range.start;
    const end = e && isIsoDate(e) ? e : range.end;
    range = start <= end ? { start, end } : { start: end, end: start };
  }

  const filters: Filters = {
    preset,
    ...range,
    basis: pick(params.get("basis"), REVENUE_BASES, "booked"),
    measure: pick(params.get("measure"), REVENUE_MEASURES, "net"),
    compare: pick(params.get("compare"), ["none", "previous_period", "previous_year"] as const, "previous_year"),
    granularity: pick(params.get("by"), GRANULARITIES, autoGranularity(range.start, range.end)),
  };

  const update = (patch: Partial<Filters>) => {
    const next = new URLSearchParams(params);
    if (patch.preset) {
      next.set("range", patch.preset);
      if (patch.preset !== "custom") {
        next.delete("start");
        next.delete("end");
      }
      // A new range usually wants a new bucket size.
      if (!patch.granularity) next.delete("by");
    }
    if (patch.start) next.set("start", patch.start);
    if (patch.end) next.set("end", patch.end);
    if (patch.basis) next.set("basis", patch.basis);
    if (patch.measure) next.set("measure", patch.measure);
    if (patch.compare) next.set("compare", patch.compare);
    if (patch.granularity) next.set("by", patch.granularity);
    setParams(next, { replace: true });
  };

  return [filters, update];
}
