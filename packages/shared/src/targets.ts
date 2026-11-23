import { z } from "zod";
import { BUSINESS_LINE_INFO, BUSINESS_LINES, isBusinessLine, type BusinessLine } from "./businessLines.js";
import { addDays, type IsoDate } from "./dates.js";
import { yearBefore } from "./campminderFinance.js";
import type { RegistrationSettings } from "./seasons.js";

/**
 * Targets: a goal per business line, season and measure (Settings → Targets),
 * compared with where the line is now and where it would be by now at last
 * season's pace.
 *
 * - revenue:      net (after discounts and refunds, before fees) of the season's
 *                 programs (service dates in the season), counted when booked.
 * - campers,
 *   enrollments:  enrolled Campminder campers / camper-sessions of the season,
 *                 counted by application date.
 * - guests:       FareHarbor guests with activity dates in the season, by booking date.
 * - participants: participants on won HubSpot deals with program dates in the
 *                 season (Settings → HubSpot), by close date.
 */
export const TARGET_MEASURES = ["revenue", "campers", "enrollments", "guests", "participants"] as const;
export type TargetMeasure = (typeof TARGET_MEASURES)[number];

export const TARGET_MEASURE_INFO: Record<TargetMeasure, { label: string; money: boolean; help: string }> = {
  revenue: { label: "Net revenue", money: true, help: "After discounts and refunds, before fees. The season's programs, counted as soon as they're booked." },
  campers: { label: "Campers", money: false, help: "Enrolled campers in the Campminder season, by sign-up date." },
  enrollments: { label: "Enrollments", money: false, help: "Enrolled camper-sessions in the Campminder season, by sign-up date." },
  guests: { label: "Guests", money: false, help: "FareHarbor guests with activity dates in the season, by booking date." },
  participants: { label: "Participants", money: false, help: "Participants on won HubSpot deals with program dates in the season, by close date." },
};

/** The measures a line can have targets for: revenue, plus what its platforms count. */
export function lineTargetMeasures(line: BusinessLine): TargetMeasure[] {
  const sources = BUSINESS_LINE_INFO[line].sources;
  const out: TargetMeasure[] = ["revenue"];
  if (sources.includes("campminder")) out.push("campers", "enrollments");
  if (sources.includes("fareharbor")) out.push("guests");
  if (sources.includes("hubspot")) out.push("participants");
  return out;
}

/** Season year → line → measure → target. Missing = no target. */
export type TargetValues = Partial<Record<BusinessLine, Partial<Record<TargetMeasure, number>>>>;
export interface TargetSettings {
  seasons: Record<string, TargetValues>;
}
export const EMPTY_TARGET_SETTINGS: TargetSettings = { seasons: {} };

const amount = z.number().finite().nonnegative().max(1e10);
export const targetSettingsSchema = z.object({
  seasons: z.record(
    z.string().regex(/^20\d\d$/),
    z.record(z.string(), z.record(z.string(), amount)),
  ),
});

/** Keeps only known lines, measures the line can have, and real numbers; drops empty seasons. */
export function cleanTargetSettings(raw: unknown): TargetSettings {
  const parsed = targetSettingsSchema.safeParse(raw);
  if (!parsed.success) return EMPTY_TARGET_SETTINGS;
  const seasons: Record<string, TargetValues> = {};
  for (const [year, lines] of Object.entries(parsed.data.seasons)) {
    const values: TargetValues = {};
    for (const [line, measures] of Object.entries(lines)) {
      if (!isBusinessLine(line)) continue;
      const allowed = lineTargetMeasures(line);
      const kept = Object.fromEntries(Object.entries(measures).filter(([m]) => (allowed as string[]).includes(m)));
      if (Object.keys(kept).length) values[line] = kept as Partial<Record<TargetMeasure, number>>;
    }
    if (Object.keys(values).length) seasons[year] = values;
  }
  return { seasons };
}

/** Seasons (newest first) with at least one target for the line. */
export function targetSeasons(settings: TargetSettings, line: BusinessLine): number[] {
  return Object.entries(settings.seasons)
    .filter(([, v]) => Object.keys(v[line] ?? {}).length > 0)
    .map(([y]) => Number(y))
    .sort((a, b) => b - a);
}

/**
 * The season a line's targets card opens on: the season under way if it has
 * targets, else the next one (planning ahead), else the newest with targets.
 */
export function defaultTargetSeason(withTargets: number[], current: number): number | null {
  if (withTargets.includes(current)) return current;
  if (withTargets.includes(current + 1)) return current + 1;
  return withTargets[0] ?? null;
}

/** Within ±5% of expected by now counts as on track. */
export const ON_TRACK_TOLERANCE = 0.05;

export type TargetStatus = "ahead" | "on_track" | "behind" | "reached" | "missed" | "no_pace";
export const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
  ahead: "Ahead",
  on_track: "On track",
  behind: "Behind",
  reached: "Reached",
  missed: "Missed",
  no_pace: "No pace yet",
};

/**
 * Expected by now: the target times the share of last season's final total it
 * had reached by the same point. Null when last season has nothing to go by.
 */
export function expectedByNow(target: number, lastAtSamePoint: number, lastFinal: number): number | null {
  if (!(lastFinal > 0)) return null;
  const share = Math.min(1, Math.max(0, lastAtSamePoint / lastFinal));
  return target * share;
}

export function targetStatus(p: { target: number; actual: number; expected: number | null; ended: boolean }): TargetStatus {
  if (p.ended) return p.actual >= p.target ? "reached" : "missed";
  if (p.expected === null) return "no_pace";
  if (p.expected <= 0) return p.actual > 0 ? "ahead" : "on_track";
  const ratio = p.actual / p.expected;
  if (ratio > 1 + ON_TRACK_TOLERANCE) return "ahead";
  if (ratio < 1 - ON_TRACK_TOLERANCE) return "behind";
  return "on_track";
}

/** How last season's "same point" is found. */
export type PaceAlignment = "date" | "weekday" | "registration";
export const PACE_ALIGNMENT_LABEL: Record<PaceAlignment, string> = {
  date: "the same date last year",
  weekday: "the same weekday last year",
  registration: "the same number of days since registration opened",
};

/** First day any registration wave opened for a season (null when not set). */
export function registrationOpened(registration: RegistrationSettings, season: number): IsoDate | null {
  const days = Object.values(registration.opens[String(season)] ?? {}).filter((d): d is IsoDate => !!d);
  return days.length ? days.sort()[0]! : null;
}

/**
 * Last season's "same point" for `asOf` in `season`. Camp lines up by days
 * since registration opened (when both seasons' dates are set); lines compared
 * by weekday go back 364 days; the rest go back to the same date last year.
 */
export function samePointLastSeason(
  line: BusinessLine,
  season: number,
  asOf: IsoDate,
  registration: RegistrationSettings,
): { cutoff: IsoDate; alignedBy: PaceAlignment } {
  if (line === "camp") {
    const now = registrationOpened(registration, season);
    const before = registrationOpened(registration, season - 1);
    if (now && before) {
      const days = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) / 86_400_000);
      return { cutoff: addDays(before, days), alignedBy: "registration" };
    }
  }
  if (BUSINESS_LINE_INFO[line].weekdayComparison) return { cutoff: addDays(asOf, -364), alignedBy: "weekday" };
  return { cutoff: yearBefore(asOf), alignedBy: "date" };
}

/** What the warehouse returns per measure: this season so far, and last season at the same point and in full. */
export interface TargetActual {
  current: number;
  previousAtSamePoint: number;
  previousFinal: number;
}
export type TargetActuals = Record<TargetMeasure, TargetActual>;

export interface TargetProgressRow {
  measure: TargetMeasure;
  target: number;
  actual: number;
  /** Null when last season has nothing to go by. */
  expected: number | null;
  status: TargetStatus;
  lastSeason: { atSamePoint: number; final: number };
}

export interface TargetProgressResponse {
  businessLine: BusinessLine;
  /** Null when the line has no targets. */
  season: number | null;
  /** Seasons with targets for this line, newest first. */
  seasons: number[];
  /** The season's dates (line's season rule). */
  range: { start: IsoDate; end: IsoDate } | null;
  /** Counted through this day. */
  asOf: IsoDate;
  ended: boolean;
  /** Last season's same point, and how it was found. */
  samePoint: IsoDate | null;
  alignedBy: PaceAlignment | null;
  rows: TargetProgressRow[];
}

/** Rows for every measure the season has a target for, in the line's measure order. */
export function targetProgressRows(line: BusinessLine, targets: Partial<Record<TargetMeasure, number>>, actuals: TargetActuals, ended: boolean): TargetProgressRow[] {
  return lineTargetMeasures(line).flatMap((measure) => {
    const target = targets[measure];
    if (target === undefined) return [];
    const a = actuals[measure];
    const expected = ended ? target : expectedByNow(target, a.previousAtSamePoint, a.previousFinal);
    return [
      {
        measure,
        target,
        actual: a.current,
        expected,
        status: targetStatus({ target, actual: a.current, expected, ended }),
        lastSeason: { atSamePoint: a.previousAtSamePoint, final: a.previousFinal },
      },
    ];
  });
}

export const targetProgressQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES),
  season: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type TargetProgressQuery = z.infer<typeof targetProgressQuerySchema>;

export const EMPTY_TARGET_ACTUAL: TargetActual = { current: 0, previousAtSamePoint: 0, previousFinal: 0 };
export const emptyTargetActuals = (): TargetActuals =>
  Object.fromEntries(TARGET_MEASURES.map((m) => [m, { ...EMPTY_TARGET_ACTUAL }])) as TargetActuals;
