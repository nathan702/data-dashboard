import { z } from "zod";
import { BUSINESS_LINES, type BusinessLine } from "./businessLines.js";
import { addDays, isIsoDate, type IsoDate } from "./dates.js";

/**
 * Seasons. Each business line groups its numbers into seasons by program or
 * activity date, by one of these rules (set on the Settings page):
 *
 * - calendar:   season Y is January 1 – December 31 of Y.
 * - campminder: Campminder's own seasons. Season Y ends the day before Labor
 *               Day of Y (after the last week of camp); anything starting on
 *               Labor Day or later belongs to Y+1. A year can be overridden.
 * - end_dates:  season Y ends on a date set for that year (e.g. the last night
 *               of the Haunted Forest run); the day after starts Y+1.
 *
 * Seasons are named by the year they end in.
 */
export const SEASON_RULES = ["calendar", "campminder", "end_dates"] as const;
export type SeasonRule = (typeof SEASON_RULES)[number];

export const SEASON_RULE_LABEL: Record<SeasonRule, string> = {
  calendar: "Calendar year",
  campminder: "Campminder season (starts Labor Day)",
  end_dates: "Ends on a date set each year",
};

export interface SeasonSettings {
  rules: Record<BusinessLine, SeasonRule>;
  /** For "end_dates" lines: season year → its last day. */
  endDates: Partial<Record<BusinessLine, Record<string, IsoDate>>>;
  /** Campminder seasons that don't start on Labor Day: season year → its first day. */
  campminderStarts: Record<string, IsoDate>;
}

export const DEFAULT_SEASON_SETTINGS: SeasonSettings = {
  rules: {
    camp: "calendar",
    river_school: "calendar",
    events: "calendar",
    haunted_forest: "end_dates",
    chaps: "calendar",
    education: "calendar",
    school_year: "campminder",
    river_store: "calendar",
    farm_store: "calendar",
  },
  endDates: { haunted_forest: { "2026": "2026-11-08" } },
  campminderStarts: {},
};

const yearKey = z.string().regex(/^\d{4}$/);
const isoDate = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");

export const seasonSettingsSchema = z.object({
  rules: z.record(z.enum(BUSINESS_LINES), z.enum(SEASON_RULES)),
  endDates: z.partialRecord(z.enum(BUSINESS_LINES), z.record(yearKey, isoDate)),
  campminderStarts: z.record(yearKey, isoDate),
});

/** Fill anything missing (e.g. a new business line) from the defaults. */
export function cleanSeasonSettings(raw: unknown): SeasonSettings {
  const r = (raw ?? {}) as Partial<SeasonSettings>;
  const merged = {
    rules: { ...DEFAULT_SEASON_SETTINGS.rules, ...(r.rules ?? {}) },
    endDates: r.endDates ?? DEFAULT_SEASON_SETTINGS.endDates,
    campminderStarts: r.campminderStarts ?? {},
  };
  const parsed = seasonSettingsSchema.safeParse(merged);
  return parsed.success ? (parsed.data as SeasonSettings) : DEFAULT_SEASON_SETTINGS;
}

/** First Monday of September. */
export function laborDay(year: number): IsoDate {
  const sep1 = new Date(Date.UTC(year, 8, 1));
  const offset = (8 - sep1.getUTCDay()) % 7; // days until Monday
  return `${year}-09-${String(1 + offset).padStart(2, "0")}`;
}

export interface SeasonCalendar {
  rule: SeasonRule;
  /** Last day of season `year`. */
  lastDay(year: number): IsoDate;
  seasonFor(date: IsoDate): number;
  range(season: number): { start: IsoDate; end: IsoDate };
}

function calendarFrom(rule: SeasonRule, lastDay: (year: number) => IsoDate): SeasonCalendar {
  return {
    rule,
    lastDay,
    seasonFor(date) {
      const y = Number(date.slice(0, 4));
      if (date > lastDay(y)) return y + 1;
      if (date <= lastDay(y - 1)) return y - 1;
      return y;
    },
    range(season) {
      return { start: addDays(lastDay(season - 1), 1), end: lastDay(season) };
    },
  };
}

export const CALENDAR_YEAR: SeasonCalendar = calendarFrom("calendar", (y) => `${y}-12-31`);

/** Campminder's seasons: Labor Day starts the next one, unless a year says otherwise. */
export function campminderCalendar(starts: Record<string, IsoDate> = {}): SeasonCalendar {
  const firstDay = (season: number) => starts[String(season)] ?? laborDay(season - 1);
  return calendarFrom("campminder", (y) => addDays(firstDay(y + 1), -1));
}

/**
 * Seasons ending on dates set per year. A year with no date reuses the month
 * and day of the nearest year that has one (or November 1).
 */
export function endDateCalendar(ends: Record<string, IsoDate> = {}): SeasonCalendar {
  const years = Object.keys(ends).map(Number).sort((a, b) => a - b);
  return calendarFrom("end_dates", (y) => {
    const set = ends[String(y)];
    if (set) return set;
    const nearest = years.length ? years.reduce((best, x) => (Math.abs(x - y) < Math.abs(best - y) ? x : best)) : null;
    const md = nearest !== null ? ends[String(nearest)]!.slice(5) : "11-01";
    return `${y}-${md === "02-29" ? "02-28" : md}`;
  });
}

export function lineCalendar(line: BusinessLine, settings: SeasonSettings = DEFAULT_SEASON_SETTINGS): SeasonCalendar {
  switch (settings.rules[line]) {
    case "calendar":
      return CALENDAR_YEAR;
    case "campminder":
      return campminderCalendar(settings.campminderStarts);
    case "end_dates":
      return endDateCalendar(settings.endDates[line]);
  }
}

/** First days of every season touching [start, end], for bucketing by season. */
export function seasonStarts(cal: SeasonCalendar, start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let s = cal.seasonFor(start); s <= cal.seasonFor(end); s++) out.push(cal.range(s).start);
  return out;
}

/** A season bucket is labelled by its first day; seasons are named by the year they end in. */
export function seasonNameFromStart(start: IsoDate): number {
  return start.slice(5) === "01-01" ? Number(start.slice(0, 4)) : Number(start.slice(0, 4)) + 1;
}
