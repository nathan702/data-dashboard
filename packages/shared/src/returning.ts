import { z } from "zod";
import { yearBefore } from "./campminderFinance.js";
import { daysBetweenInclusive, type IsoDate } from "./dates.js";
import type { CampLocation, RegistrationSettings } from "./seasons.js";

/**
 * Returning families: households with a camper enrolled at a camp location
 * (Settings → Seasons → Registration: session group → VA or MD) last season,
 * and whether they've signed up for Camp again this season.
 *
 * The warehouse supplies plain facts per family (ReturningFamilyFacts); every
 * rule (wave, status, age-out, "same point last year") is worked out here, so
 * the Camp page, the report builder and the digests can't disagree.
 */

export const RETURNING_STATUSES = ["enrolled", "waitlisted", "cancelled", "not_yet", "aged_out"] as const;
export type ReturningStatus = (typeof RETURNING_STATUSES)[number];

export const RETURNING_STATUS_LABEL: Record<ReturningStatus, string> = {
  enrolled: "Re-enrolled",
  waitlisted: "Waitlisted or applied",
  cancelled: "Signed up, then cancelled",
  not_yet: "Not yet",
  aged_out: "Aged out",
};

/** What the warehouse knows about one returning family for one season. */
export interface ReturningFamilyFacts {
  /** The season the family is expected back for (it was at camp the season before). */
  season: number;
  /** Household (scrambled ID, the same as elsewhere). */
  household: string;
  /** Camp locations (VA / MD) its campers attended last season. */
  locations: CampLocation[];
  /** Last season's camp-location session group with the most camper-weeks. */
  sessionGroup: string;
  /** Camper-weeks at camp locations last season. */
  weeks: number;
  /** Most summers at camp among its campers, as of last season (1 = their first summer). */
  summers: number | null;
  state: string | null;
  zip: string | null;
  /** Last season's campers at camp locations: age on June 1 last season, and whether enrolled in Camp this season. */
  campers: Array<{ age: number | null; enrolled: boolean }>;
  /** Any of the household's campers (new siblings too) in Camp this season: enrolled; waitlisted or applied; cancelled or withdrawn. */
  enrolled: boolean;
  waitlisted: boolean;
  cancelled: boolean;
  /** Earliest application among its enrolled Camp sessions this season. */
  enrolledOn: IsoDate | null;
}

export interface ReturningFamily extends ReturningFamilyFacts {
  /** The registration wave it signs up in: the earliest-opening of its locations. */
  wave: CampLocation;
  status: ReturningStatus;
  /** Days from its wave's opening to re-enrolling (negative: before opening); null when not re-enrolled or no opening date. */
  day: number | null;
  /** Last season's campers still young enough for Camp this season, and how many of them are enrolled. */
  eligibleCampers: number;
  reenrolledCampers: number;
}

/**
 * The oldest a camper can be on June 1 of the season and still count as
 * coming back: the setting (Settings → Seasons → Registration), else the oldest
 * age at least 1% of last season's campers were (so one camper entered with a
 * wrong birth date doesn't move it). Null: no ages known, so nobody ages out.
 */
export function ageOutAfter(facts: ReturningFamilyFacts[], setting: number | null | undefined): number | null {
  if (setting !== null && setting !== undefined) return setting;
  const ages = facts.flatMap((f) => f.campers.map((c) => c.age)).filter((a): a is number => a !== null);
  if (!ages.length) return null;
  const counts = new Map<number, number>();
  for (const a of ages) counts.set(a, (counts.get(a) ?? 0) + 1);
  const common = [...counts].filter(([, n]) => n >= ages.length * 0.01).map(([a]) => a);
  return Math.max(...(common.length ? common : ages));
}

/** A camper (age on June 1 last season) is young enough for Camp this season. */
const youngEnough = (age: number | null, oldest: number | null) => oldest === null || age === null || age + 1 <= oldest;

const daysFrom = (from: IsoDate, to: IsoDate) => daysBetweenInclusive(from, to) - 1;

function waveOf(locations: CampLocation[], opens: Partial<Record<string, IsoDate>> | undefined): CampLocation {
  // Same rule as registrationPaceSql: earliest opening, then alphabetical.
  const sorted = [...locations].sort((a, b) => {
    const oa = opens?.[a] ?? "9999";
    const ob = opens?.[b] ?? "9999";
    return oa < ob ? -1 : oa > ob ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  return sorted[0] ?? "va";
}

/** Each family's wave, status and re-enrollment day, with campers aged out under the season's cutoff. */
export function resolveReturning(facts: ReturningFamilyFacts[], registration: RegistrationSettings): ReturningFamily[] {
  const bySeason = new Map<number, ReturningFamilyFacts[]>();
  for (const f of facts) bySeason.set(f.season, [...(bySeason.get(f.season) ?? []), f]);
  const oldest = new Map([...bySeason].map(([s, fs]) => [s, ageOutAfter(fs, registration.ageOutAfter)]));
  return facts.map((f) => {
    const opens = registration.opens[String(f.season)];
    const wave = waveOf(f.locations, opens);
    const eligible = f.campers.filter((c) => youngEnough(c.age, oldest.get(f.season) ?? null));
    const status: ReturningStatus = f.enrolled
      ? "enrolled"
      : f.waitlisted
        ? "waitlisted"
        : f.cancelled
          ? "cancelled"
          : eligible.length === 0
            ? "aged_out"
            : "not_yet";
    const open = opens?.[wave];
    return {
      ...f,
      wave,
      status,
      day: f.enrolled && f.enrolledOn && open ? daysFrom(open, f.enrolledOn) : null,
      eligibleCampers: eligible.length,
      reenrolledCampers: eligible.filter((c) => c.enrolled).length,
    };
  });
}

/** Where "now" is: today, and whether the season's registration is over (its summer has ended). */
export interface ReturningAsOf {
  today: IsoDate;
  over: boolean;
}

/**
 * Whether a family of the season before had re-enrolled by the same point:
 * the same number of days since its wave opened (both seasons' opening dates
 * needed), else by the same date a year earlier; everything once the season is over.
 */
function reenrolledBySamePoint(f: ReturningFamily, opens: RegistrationSettings["opens"], season: number, asOf: ReturningAsOf): boolean {
  if (f.status !== "enrolled") return false;
  if (asOf.over) return true;
  const open = opens[String(season)]?.[f.wave];
  if (open && f.day !== null) return f.day <= daysFrom(open, asOf.today);
  return !!f.enrolledOn && f.enrolledOn <= yearBefore(asOf.today);
}

export interface ReturningCounts {
  /** Returning families still young enough for Camp (aged-out families left out). */
  families: number;
  enrolled: number;
  waitlisted: number;
  cancelled: number;
  notYet: number;
  agedOut: number;
  /** Last season's campers young enough to come back, and how many have. */
  eligibleCampers: number;
  reenrolledCampers: number;
}

export function returningCounts(fams: ReturningFamily[]): ReturningCounts {
  const n = (s: ReturningStatus) => fams.filter((f) => f.status === s).length;
  const kept = fams.filter((f) => f.status !== "aged_out");
  return {
    families: kept.length,
    enrolled: n("enrolled"),
    waitlisted: n("waitlisted"),
    cancelled: n("cancelled"),
    notYet: n("not_yet"),
    agedOut: n("aged_out"),
    eligibleCampers: kept.reduce((t, f) => t + f.eligibleCampers, 0),
    reenrolledCampers: kept.reduce((t, f) => t + f.reenrolledCampers, 0),
  };
}

export interface ReturningSummary {
  season: number;
  current: ReturningCounts;
  /** The season before: re-enrolled by the same point, and in the end. */
  previous: { families: number; samePoint: number; final: number } | null;
}

/** Share of families (aged-out ones left out); null when there are none. */
export const share = (n: number, of: number) => (of > 0 ? n / of : null);

export function returningSummary(fams: ReturningFamily[], season: number, registration: RegistrationSettings, asOf: ReturningAsOf): ReturningSummary {
  const cur = fams.filter((f) => f.season === season);
  const prev = fams.filter((f) => f.season === season - 1 && f.status !== "aged_out");
  return {
    season,
    current: returningCounts(cur),
    previous: prev.length
      ? {
          families: prev.length,
          samePoint: prev.filter((f) => reenrolledBySamePoint(f, registration.opens, season, asOf)).length,
          final: prev.filter((f) => f.status === "enrolled").length,
        }
      : null,
  };
}

/** Days since registration first opened for the season (any wave), or null before any date is set. */
export function daysSinceOpening(season: number, registration: RegistrationSettings, today: IsoDate, wave?: CampLocation): number | null {
  const o = registration.opens[String(season)];
  const dates = (wave ? [o?.[wave]] : [o?.va, o?.md]).filter((d): d is IsoDate => !!d).sort();
  return dates.length ? daysFrom(dates[0]!, today) : null;
}

/**
 * Share of each season's returning families re-enrolled by each day since
 * their wave opened (day -1 = before opening). The current season stops at
 * today unless it's over; families without an opening date aren't on it.
 */
export function returningCurve(
  fams: ReturningFamily[],
  seasons: number[],
  registration: RegistrationSettings,
  asOf: ReturningAsOf & { season: number },
  maxDay = 180,
): Array<{ day: number } & Record<string, number | null>> {
  const cohorts = seasons.map((s) => {
    const kept = fams.filter((f) => f.season === s && f.status !== "aged_out");
    const byDay = new Map<number, number>();
    for (const f of kept) if (f.status === "enrolled" && f.day !== null) byDay.set(Math.max(-1, f.day), (byDay.get(Math.max(-1, f.day)) ?? 0) + 1);
    const stop = s === asOf.season && !asOf.over ? daysSinceOpening(s, registration, asOf.today) : null;
    return { s, kept: kept.length, byDay, stop };
  });
  const last = Math.min(maxDay, Math.max(0, ...cohorts.flatMap((c) => [...c.byDay.keys()])));
  const out: Array<{ day: number } & Record<string, number | null>> = [];
  const totals = new Map<number, number>();
  for (let day = -1; day <= last; day++) {
    const row: { day: number } & Record<string, number | null> = { day };
    for (const c of cohorts) {
      totals.set(c.s, (totals.get(c.s) ?? 0) + (c.byDay.get(day) ?? 0));
      row[String(c.s)] = c.kept === 0 || (c.stop !== null && day > c.stop) || (c.s === asOf.season && !asOf.over && c.stop === null) ? null : totals.get(c.s)! / c.kept;
    }
    out.push(row);
  }
  return out;
}

// ---------- segments (the Camp card's breakdown and filters, and report fields) ----------

export const RETURNING_SEGMENTS = ["wave", "session_group", "summers", "campers", "weeks", "state", "status"] as const;
export type ReturningSegment = (typeof RETURNING_SEGMENTS)[number];

export const RETURNING_SEGMENT_LABEL: Record<ReturningSegment, string> = {
  wave: "Wave",
  session_group: "Last season's location",
  summers: "Summers at camp",
  campers: "Campers last season",
  weeks: "Weeks last season",
  state: "Home state",
  status: "Status",
};

export const RETURNING_WAVE_LABEL: Record<CampLocation, string> = { va: "Returning VA", md: "Returning MD" };

const bucket = (n: number, edges: Array<[number, string]>, last: string) => edges.find(([max]) => n <= max)?.[1] ?? last;

export function returningSegmentKey(f: ReturningFamily, d: ReturningSegment): string | null {
  switch (d) {
    case "wave":
      return RETURNING_WAVE_LABEL[f.wave];
    case "session_group":
      return f.sessionGroup;
    case "summers":
      return f.summers === null ? null : bucket(f.summers, [[1, "1 summer"], [2, "2 summers"], [3, "3 summers"]], "4+ summers");
    case "campers":
      return bucket(f.campers.length, [[1, "1 camper"], [2, "2 campers"]], "3+ campers");
    case "weeks":
      return bucket(f.weeks, [[2, "1–2 weeks"], [4, "3–4 weeks"], [8, "5–8 weeks"]], "9+ weeks");
    case "state":
      return f.state;
    case "status":
      return RETURNING_STATUS_LABEL[f.status];
  }
}

/** Segment values in their natural order (buckets) or by size. */
export const RETURNING_SEGMENT_ORDER: Partial<Record<ReturningSegment, string[]>> = {
  wave: Object.values(RETURNING_WAVE_LABEL),
  summers: ["1 summer", "2 summers", "3 summers", "4+ summers"],
  campers: ["1 camper", "2 campers", "3+ campers"],
  weeks: ["1–2 weeks", "3–4 weeks", "5–8 weeks", "9+ weeks"],
  status: RETURNING_STATUSES.map((s) => RETURNING_STATUS_LABEL[s]),
};

export type ReturningFilters = Partial<Record<ReturningSegment, string[]>>;

/** Families matching every filtered segment (a family with no value matches "(unknown)"). */
export function filterReturning(fams: ReturningFamily[], filters: ReturningFilters, unknown = "(unknown)"): ReturningFamily[] {
  const active = Object.entries(filters).filter(([, v]) => v && v.length > 0) as Array<[ReturningSegment, string[]]>;
  return fams.filter((f) => active.every(([d, values]) => values.includes(returningSegmentKey(f, d) ?? unknown)));
}

/** "Weeks after opening" for reports: 0 = the week the wave opened, -1 = before it opened. */
export const weeksAfterOpening = (day: number | null) => (day === null ? null : day < 0 ? -1 : Math.floor(day / 7));

// ---------- API ----------

export const returningQuerySchema = z.object({ season: z.coerce.number().int().min(2000).max(2100).optional() });
export type ReturningQuery = z.infer<typeof returningQuerySchema>;

export interface ReturningResponse {
  /** The season shown, and every season with returning families (newest first). */
  season: number;
  seasons: number[];
  asOf: ReturningAsOf;
  /** Families for the season shown and the two before it. */
  families: ReturningFamily[];
  /** Oldest age on June 1 of each season still counted as coming back: the setting or the automatic value. */
  ageOutAfter: Record<string, number | null>;
  /** Whether the age is set on Settings (else automatic). */
  ageOutSet: boolean;
  /** Registration opening dates of those seasons. */
  opens: RegistrationSettings["opens"];
}

/**
 * The season shown unless one is asked for: the one whose registration is
 * next or under way (Campminder's season for today: after Labor Day, next
 * summer's), else the newest one with returning families. `seasons` is newest first.
 */
export function defaultReturningSeason(seasons: number[], currentCampminderSeason: number): number | undefined {
  return seasons.includes(currentCampminderSeason) ? currentCampminderSeason : seasons.find((s) => s <= currentCampminderSeason) ?? seasons[0];
}

/** Days from today to a date (negative once it's passed). */
export const daysUntil = (today: IsoDate, date: IsoDate) => daysFrom(today, date);
