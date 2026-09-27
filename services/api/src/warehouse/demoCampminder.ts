import {
  addDays,
  seasonRange,
  UNKNOWN_KEY,
  type BusinessLineOrUnassigned,
  type EnrollmentBreakdownQuery,
  type EnrollmentBreakdownResponse,
  type EnrollmentBreakdownRow,
  type EnrollmentDimension,
  type EnrollmentFilters,
  type EnrollmentMapQuery,
  type EnrollmentMapResponse,
  type EnrollmentSeason,
  type EnrollmentSummaryQuery,
  type EnrollmentSummaryResponse,
} from "@dash/shared";
import { buildPace, enrollmentAsOf, sortBreakdown, toEnrollmentKpis, toMapResponse } from "./campminder.js";
import { noise } from "./demo.js";

/** Made-up camper-sessions for local development only. */
interface Row {
  businessLine: BusinessLineOrUnassigned;
  season: number;
  camper: string;
  sessionGroup: string;
  sessionName: string;
  weekStart: number | null;
  weekEnd: number | null;
  program: string | null;
  statusCode: string;
  status: string;
  age: number;
  grade: string;
  gender: string;
  years: number;
  state: string;
  applicationDate: string;
  homeLat: number | null;
  homeLon: number | null;
}

/** Made-up home areas around DC, weighted roughly like a real camp's families. */
const AREAS: Array<[number, number, number]> = [
  [38.9807, -77.1003, 0.22], // Bethesda
  [38.9296, -77.0628, 0.18], // NW DC
  [38.8816, -77.091, 0.14], // Arlington
  [38.9338, -77.1773, 0.1], // McLean
  [39.0228, -77.0304, 0.1], // Silver Spring
  [38.8048, -77.0469, 0.09], // Alexandria
  [39.0184, -77.2086, 0.09], // Potomac
  [38.8462, -77.3064, 0.08], // Fairfax
];

function demoHome(camper: string): { homeLat: number | null; homeLon: number | null } {
  const n = noise(`${camper}home`);
  if (n > 0.97) return { homeLat: null, homeLon: null }; // address that didn't geocode
  let acc = 0;
  const [lat, lon] = AREAS.find(([, , w]) => (acc += w) >= n) ?? AREAS[0]!;
  const r = 0.035 * Math.sqrt(noise(`${camper}r`));
  const a = 2 * Math.PI * noise(`${camper}a`);
  return { homeLat: Math.round((lat + r * Math.sin(a)) * 1e5) / 1e5, homeLon: Math.round((lon + r * 1.3 * Math.cos(a)) * 1e5) / 1e5 };
}

const GROUPS: Array<{ group: string; line: BusinessLineOrUnassigned; weekly: boolean; programs: string[]; size: number }> = [
  { group: "Farm", line: "camp", weekly: true, programs: ["Explorers", "Explorers - Quest", "Cubs"], size: 300 },
  { group: "Riley's", line: "camp", weekly: true, programs: ["Riley's Water Sampler", "Explorers - Great Heights"], size: 230 },
  { group: "Madeira", line: "camp", weekly: true, programs: ["Virginia Sampler", "Sailing with THURSDAY CAMPOUT"], size: 140 },
  { group: "Fraser", line: "camp", weekly: true, programs: ["Rock Climbing with THURSDAY CAMPOUT", "SUP with THURSDAY CAMPOUT"], size: 90 },
  { group: "Fall Saddle Club MONDAY", line: "chaps", weekly: false, programs: [], size: 12 },
  { group: "Spring Group Lessons", line: "chaps", weekly: false, programs: [], size: 18 },
  { group: "Fall Farm and Forest Cubs", line: "school_year", weekly: false, programs: [], size: 15 },
  { group: "Spring Tiny Tots SATURDAY", line: "school_year", weekly: false, programs: [], size: 10 },
];
const GRADES = ["K", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
const STATUSES: Array<[string, string, number]> = [["EN", "Enrolled", 0.86], ["CN", "Cancelled", 0.08], ["WD", "Withdrawn", 0.055], ["WL", "Waitlisted", 0.005]];

let cache: Row[] | null = null;

function rows(): Row[] {
  if (cache) return cache;
  const out: Row[] = [];
  for (const season of [2025, 2026]) {
    const start = seasonRange(season).start;
    for (const g of GROUPS) {
      const perWeek = Math.round(g.size * (season === 2026 ? 1.06 : 1));
      for (let week = 1; week <= (g.weekly ? 12 : 1); week++) {
        for (let i = 0; i < perWeek; i++) {
          const seed = `${season}${g.group}${week}${i}`;
          const n = noise(seed);
          if (g.weekly && n < (week <= 2 || week >= 11 ? 0.45 : 0.1)) continue;
          const camperNo = Math.floor(noise(`${seed}c`) * 3000);
          const s = noise(`${seed}s`);
          const [statusCode, status] = s < 0.86 ? STATUSES[0]! : s < 0.94 ? STATUSES[1]! : s < 0.995 ? STATUSES[2]! : STATUSES[3]!;
          const age = 5 + Math.floor(noise(`${seed}a`) * 10);
          out.push({
            businessLine: g.line,
            season,
            camper: `${season % 2}${camperNo}`,
            sessionGroup: g.group,
            sessionName: g.weekly ? `${g.group} Week ${week}` : g.group,
            weekStart: g.weekly ? week : null,
            weekEnd: g.weekly ? week : null,
            program: g.programs.length ? g.programs[Math.floor(noise(`${seed}p`) * g.programs.length)]! : null,
            statusCode,
            status,
            age,
            grade: GRADES[Math.min(age - 5, GRADES.length - 1)]!,
            gender: noise(`${seed}g`) < 0.55 ? "Male" : "Female",
            years: 1 + Math.floor(Math.pow(noise(`${seed}y`), 2) * 6),
            state: ["MD", "DC", "VA"][Math.floor(noise(`${seed}st`) * 3)]!,
            // Most applications arrive in winter (weeks 16-30 of the season).
            applicationDate: addDays(start, Math.floor(Math.pow(noise(`${seed}d`), 0.8) * 300)),
            ...demoHome(`${season % 2}${camperNo}`),
          });
        }
      }
    }
  }
  cache = out;
  return out;
}

function keyOf(r: Row, d: Exclude<EnrollmentDimension, "week">): string {
  return {
    session_group: r.sessionGroup, session: r.sessionName, program: r.program ?? UNKNOWN_KEY, age: String(r.age),
    grade: r.grade, gender: r.gender, years: String(r.years), state: r.state, status: r.status,
  }[d];
}

/** Same rule as the SQL: every filtered dimension must match. */
function matches(r: Row, f: EnrollmentFilters | undefined) {
  for (const [d, values] of Object.entries(f ?? {}) as Array<[EnrollmentDimension, string[]]>) {
    if (!values.length) continue;
    if (d === "week") {
      if (r.weekStart === null || !values.some((w) => Number(w) >= r.weekStart! && Number(w) <= r.weekEnd!)) return false;
    } else if (!values.includes(keyOf(r, d))) return false;
  }
  return true;
}

const scoped = (bl: BusinessLineOrUnassigned | undefined, f?: EnrollmentFilters) =>
  rows().filter((r) => (!bl || r.businessLine === bl) && matches(r, f));

function counts(rs: Row[]) {
  const en = rs.filter((r) => r.statusCode === "EN");
  const campers = new Set(en.map((r) => r.camper));
  return {
    campers: campers.size,
    enrollments: en.length,
    new_campers: new Set(en.filter((r) => r.years === 1).map((r) => r.camper)).size,
    returning_campers: new Set(en.filter((r) => r.years > 1).map((r) => r.camper)).size,
    cancelled: rs.filter((r) => r.statusCode === "CN").length,
    withdrawn: rs.filter((r) => r.statusCode === "WD").length,
    waitlisted: rs.filter((r) => r.statusCode === "WL").length,
  };
}

export function demoEnrollmentSeasons(bl: BusinessLineOrUnassigned | undefined): EnrollmentSeason[] {
  const m = new Map<number, number>();
  for (const r of scoped(bl)) if (r.statusCode === "EN") m.set(r.season, (m.get(r.season) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([season, enrollments]) => ({ season, enrollments }));
}

export function demoEnrollmentSummary(q: EnrollmentSummaryQuery): EnrollmentSummaryResponse {
  const { asOf, prevCutoff, seasonStart } = enrollmentAsOf(q.season);
  const all = scoped(q.businessLine, q.filters);
  const cur = all.filter((r) => r.season === q.season);
  const prev = all.filter((r) => r.season === q.season - 1 && r.applicationDate <= prevCutoff);
  const weeks = new Map<number, number>();
  for (const r of cur) if (r.statusCode === "EN" && r.weekStart !== null) for (let w = r.weekStart; w <= r.weekEnd!; w++) weeks.set(w, (weeks.get(w) ?? 0) + 1);
  const paceRows = new Map<string, { season: number; week_of_season: number; enrollments: number }>();
  for (const r of all) {
    if (r.statusCode !== "EN" || (r.season !== q.season && r.season !== q.season - 1)) continue;
    const start = seasonRange(r.season).start;
    const wk = Math.min(52, Math.max(0, Math.floor((Date.parse(r.applicationDate) - Date.parse(start)) / (7 * 86_400_000))));
    const k = `${r.season}|${wk}`;
    const e = paceRows.get(k) ?? { season: r.season, week_of_season: wk, enrollments: 0 };
    e.enrollments++;
    paceRows.set(k, e);
  }
  return {
    season: q.season,
    businessLine: q.businessLine ?? null,
    current: toEnrollmentKpis(counts(cur)),
    comparison: prev.length ? toEnrollmentKpis(counts(prev)) : null,
    byWeek: [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([week, enrollments]) => ({ week, enrollments })),
    pace: buildPace([...paceRows.values()], q.season, asOf, seasonStart),
    asOf,
  };
}

export function demoEnrollmentBreakdown(q: EnrollmentBreakdownQuery): EnrollmentBreakdownResponse {
  const cur = scoped(q.businessLine, q.filters).filter((r) => r.season === q.season);
  const groups = new Map<string, Row[]>();
  const add = (k: string, r: Row) => groups.set(k, [...(groups.get(k) ?? []), r]);
  for (const r of cur) {
    if (q.dimension === "week") {
      if (r.weekStart !== null) for (let w = r.weekStart; w <= r.weekEnd!; w++) add(String(w), r);
      continue;
    }
    add(keyOf(r, q.dimension), r);
  }
  const out: EnrollmentBreakdownRow[] = [...groups.entries()].map(([key, rs]) => {
    const c = counts(rs);
    return { key, campers: c.campers, enrollments: c.enrollments, cancelled: c.cancelled, withdrawn: c.withdrawn, waitlisted: c.waitlisted };
  });
  return { season: q.season, businessLine: q.businessLine ?? null, dimension: q.dimension, rows: sortBreakdown(out, q.dimension) };
}

/** Demo stand-ins for Campminder session groups on the Settings page. */
export const DEMO_SESSION_GROUPS = GROUPS.map((g) => ({
  key: g.group,
  label: g.group,
  defaultLine: g.line,
  activity: rows().filter((r) => r.sessionGroup === g.group && r.season === 2026 && r.statusCode === "EN").length,
}));

export function demoEnrollmentMap(q: EnrollmentMapQuery): EnrollmentMapResponse {
  const statusFiltered = (q.filters?.status ?? []).length > 0;
  const cur = scoped(q.businessLine, q.filters).filter((r) => r.season === q.season && (statusFiltered || r.statusCode === "EN"));
  const homes = new Map<string, { lat: number | null; lon: number | null; campers: Set<string>; enrollments: number }>();
  for (const r of cur) {
    const k = `${r.homeLat},${r.homeLon}`;
    const h = homes.get(k) ?? { lat: r.homeLat, lon: r.homeLon, campers: new Set(), enrollments: 0 };
    h.campers.add(r.camper);
    h.enrollments++;
    homes.set(k, h);
  }
  const rows = [...homes.values()].map((h) => ({ lat: h.lat, lon: h.lon, campers: h.campers.size, enrollments: h.enrollments, families: h.lat === null ? h.campers.size : 1 }));
  return toMapResponse(q.season, rows);
}
