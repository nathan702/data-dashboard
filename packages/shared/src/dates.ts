/**
 * Date helpers. All reporting is in US Eastern time, and dates travel as
 * ISO "YYYY-MM-DD" strings so they never pick up a timezone by accident.
 */
export const REPORTING_TIME_ZONE = "America/New_York";

/**
 * A Campminder season named Y runs from the day after camp ends in Y-1
 * through the end of summer Y. The cutover (first day of the new season) is
 * configurable; it defaults to September 1.
 */
export interface SeasonConfig {
  /** 1-12 */
  startMonth: number;
  /** 1-31 */
  startDay: number;
}

export const DEFAULT_SEASON_CONFIG: SeasonConfig = { startMonth: 9, startDay: 1 };

export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE.test(value)) return false;
  const d = parseIsoDate(value);
  return formatIsoDate(d) === value;
}

function parseIsoDate(value: IsoDate): Date {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return formatIsoDate(d);
}

/** Shift by whole years, clamping Feb 29 to Feb 28 in non-leap years. */
export function addYears(date: IsoDate, years: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const targetYear = y + years;
  const lastDay = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  return formatIsoDate(new Date(Date.UTC(targetYear, m - 1, Math.min(d, lastDay))));
}

/** Inclusive day count between two dates. */
export function daysBetweenInclusive(start: IsoDate, end: IsoDate): number {
  return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / 86_400_000) + 1;
}

/** The calendar date in Eastern time for an instant (defaults to now). */
export function easternDate(instant: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function seasonForDate(date: IsoDate, config: SeasonConfig = DEFAULT_SEASON_CONFIG): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const onOrAfterCutover = m > config.startMonth || (m === config.startMonth && d >= config.startDay);
  return onOrAfterCutover ? y + 1 : y;
}

export function seasonRange(
  season: number,
  config: SeasonConfig = DEFAULT_SEASON_CONFIG,
): { start: IsoDate; end: IsoDate } {
  const start = formatIsoDate(new Date(Date.UTC(season - 1, config.startMonth - 1, config.startDay)));
  const nextStart = formatIsoDate(new Date(Date.UTC(season, config.startMonth - 1, config.startDay)));
  return { start, end: addDays(nextStart, -1) };
}

export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

export type ComparisonMode = "none" | "previous_period" | "previous_year";

/**
 * The period to compare against. "previous_year" shifts both ends back one
 * year (use it for same-period-last-year and for same-point-last-season).
 */
export function comparisonRange(range: DateRange, mode: ComparisonMode): DateRange | null {
  switch (mode) {
    case "none":
      return null;
    case "previous_period": {
      const length = daysBetweenInclusive(range.start, range.end);
      return { start: addDays(range.start, -length), end: addDays(range.start, -1) };
    }
    case "previous_year":
      return { start: addYears(range.start, -1), end: addYears(range.end, -1) };
  }
}

export type DatePreset =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days"
  | "month_to_date"
  | "year_to_date"
  | "season_to_date"
  | "last_season";

export function presetRange(
  preset: DatePreset,
  today: IsoDate = easternDate(),
  config: SeasonConfig = DEFAULT_SEASON_CONFIG,
): DateRange {
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: y, end: y };
    }
    case "last_7_days":
      return { start: addDays(today, -6), end: today };
    case "last_30_days":
      return { start: addDays(today, -29), end: today };
    case "month_to_date":
      return { start: `${today.slice(0, 7)}-01`, end: today };
    case "year_to_date":
      return { start: `${today.slice(0, 4)}-01-01`, end: today };
    case "season_to_date":
      return { start: seasonRange(seasonForDate(today, config), config).start, end: today };
    case "last_season":
      return seasonRange(seasonForDate(today, config) - 1, config);
  }
}

/**
 * Move a comparison-period date forward onto the current period, so the two
 * can be charted together. Inverse of comparisonRange().
 */
export function alignToCurrent(date: IsoDate, range: DateRange, mode: ComparisonMode): IsoDate {
  switch (mode) {
    case "none":
      return date;
    case "previous_period":
      return addDays(date, daysBetweenInclusive(range.start, range.end));
    case "previous_year":
      return addYears(date, 1);
  }
}
