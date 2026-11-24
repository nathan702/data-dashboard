import {
  addDays,
  UNKNOWN_KEY,
  campminderCalendar,
  type BusinessLineOrUnassigned,
  type EnrollmentBreakdownQuery,
  type EnrollmentBreakdownResponse,
  type EnrollmentBreakdownRow,
  type EnrollmentDimension,
  type EnrollmentFilters,
  type EnrollmentMapQuery,
  type EnrollmentMapResponse,
  type SeasonCalendar,
  type EnrollmentSeason,
  type EnrollmentSummaryQuery,
  type EnrollmentSummaryResponse,
  CAMP_EXTRAS_CATEGORY,
  type CampLineItem,
  type CampminderExtrasQuery,
  type CampminderExtrasRow,
  type CampminderFinanceQuery,
  type CampminderFinanceSummary,
  type CamperTuition,
  type CamperTuitionResponse,
  type OccupationCategory,
  type RegistrationPaceQuery,
  type RegistrationPaceResponse,
  type RegistrationPaceRow,
  type RegistrationSettings,
  type ReturningFamilyFacts,
  type HeardAbout,
  BUSINESS_LINE_INFO,
  NEW_FAMILY,
  RETURNING_FAMILY,
  type CampLocation,
} from "@dash/shared";
import { buildPace, enrollmentAsOf, sortBreakdown, toEnrollmentKpis, toMapResponse } from "./campminder.js";
import { noise } from "./demo.js";
import type { SchoolMap } from "./reportSql.js";

/** Made-up camper-sessions for local development only. */
export interface Row {
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
  zip: string;
  /** As the family typed it (several spellings per school, like the real data). */
  school: string | null;
  /** Household (made-up): the first thousand campers come in pairs of siblings. */
  family: string;
  /** Parents' occupation categories (none for some families, two for others). */
  parentOccupations: OccupationCategory[];
  /** How the family heard about camp (the dropdown choice), or null when not answered. */
  heardAbout: HeardAbout | null;
}

/** Made-up home areas around DC, weighted roughly like a real camp's families. */
const AREAS: Array<[number, number, number, string]> = [
  [38.9807, -77.1003, 0.22, "20814"], // Bethesda
  [38.9296, -77.0628, 0.18, "20016"], // NW DC
  [38.8816, -77.091, 0.14, "22207"], // Arlington
  [38.9338, -77.1773, 0.1, "22101"], // McLean
  [39.0228, -77.0304, 0.1, "20910"], // Silver Spring
  [38.8048, -77.0469, 0.09, "22301"], // Alexandria
  [39.0184, -77.2086, 0.09, "20854"], // Potomac
  [38.8462, -77.3064, 0.08, "22030"], // Fairfax
];

function demoHome(camper: string): { homeLat: number | null; homeLon: number | null; zip: string } {
  const n = noise(`${camper}home`);
  let acc = 0;
  const [lat, lon, , zip] = AREAS.find(([, , w]) => (acc += w) >= n) ?? AREAS[0]!;
  if (noise(`${camper}geo`) > 0.97) return { homeLat: null, homeLon: null, zip }; // address that didn't geocode
  const r = 0.035 * Math.sqrt(noise(`${camper}r`));
  const a = 2 * Math.PI * noise(`${camper}a`);
  return { homeLat: Math.round((lat + r * Math.sin(a)) * 1e5) / 1e5, homeLon: Math.round((lon + r * 1.3 * Math.cos(a)) * 1e5) / 1e5, zip };
}

const GROUPS: Array<{ group: string; line: BusinessLineOrUnassigned; weekly: boolean; programs: string[]; size: number }> = [
  { group: "Farm", line: "camp", weekly: true, programs: ["Explorers - Critters and Creatures", "Explorers - Quest", "Cubs"], size: 300 },
  { group: "Riley's", line: "camp", weekly: true, programs: ["Riley's Water Sampler", "Explorers - Great Heights"], size: 230 },
  { group: "Madeira", line: "camp", weekly: true, programs: ["Virginia Sampler", "Sailing with THURSDAY CAMPOUT"], size: 140 },
  { group: "Fraser", line: "camp", weekly: true, programs: ["Rock Climbing with THURSDAY CAMPOUT", "SUP with THURSDAY CAMPOUT"], size: 90 },
  { group: "Fall Saddle Club MONDAY", line: "chaps", weekly: false, programs: [], size: 12 },
  { group: "Spring Group Lessons", line: "chaps", weekly: false, programs: [], size: 18 },
  { group: "Fall Farm and Forest Cubs", line: "school_year", weekly: false, programs: [], size: 15 },
  { group: "Spring Tiny Tots SATURDAY", line: "school_year", weekly: false, programs: [], size: 10 },
];
/** Made-up schools, each with the spellings families might type. */
const SCHOOLS: Array<[number, string[]]> = [
  [0.16, ["Maple Grove Elementary", "Maple Grove Elementary School", "maple grove elem."]],
  [0.13, ["The Hilltop School", "Hilltop", "Hilltop School"]],
  [0.12, ["Riverbend Day School", "Riverbend Day", "RDS"]],
  [0.1, ["Oak Hill Middle School", "Oak Hill MS"]],
  [0.09, ["St. Brigid's", "St Brigids", "Saint Brigid's School"]],
  [0.09, ["Cedar Park Elementary"]],
  [0.08, ["Friends Academy", "Friends Academy & Day"]],
  [0.07, ["Lakeside Montessori", "Lakeside Montessori School"]],
  [0.06, ["Homeschool", "Home school"]],
  [0.1, ["N/A", ""]],
];


function demoSchool(camper: string): string | null {
  const n = noise(`${camper}school`);
  let acc = 0;
  const [, spellings] = SCHOOLS.find(([w]) => (acc += w) >= n) ?? SCHOOLS[0]!;
  // Mostly the first spelling, sometimes another one.
  const s = noise(`${camper}spell`) < 0.65 ? spellings[0]! : spellings[Math.floor(noise(`${camper}sp2`) * spellings.length)]!;
  return s || null;
}

/** Made-up parent occupation mix. */
const OCCUPATIONS: Array<[number, OccupationCategory]> = [
  [0.16, "Legal"], [0.12, "Medicine and health"], [0.1, "Government and military"], [0.1, "Business and management"],
  [0.08, "Education"], [0.08, "Finance"], [0.07, "Technology"], [0.06, "Nonprofit"], [0.05, "Science and research"],
  [0.04, "Arts and media"], [0.04, "Real estate and construction"], [0.02, "Trades"], [0.04, "Homemaker"], [0.01, "Retired"], [0.03, "Other"],
];

function demoOccupations(camper: string): OccupationCategory[] {
  const pick = (seed: string) => {
    const n = noise(seed);
    let acc = 0;
    return (OCCUPATIONS.find(([w]) => (acc += w) >= n) ?? OCCUPATIONS[0]!)[1];
  };
  const n = noise(`${camper}parents`);
  if (n < 0.15) return []; // not answered
  const found = new Set([pick(`${camper}p1`), ...(n < 0.75 ? [pick(`${camper}p2`)] : [])]);
  return [...found];
}

const GRADES = ["K", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
const STATUSES: Array<[string, string, number]> = [["EN", "Enrolled", 0.86], ["CN", "Cancelled", 0.08], ["WD", "Withdrawn", 0.055], ["WL", "Waitlisted", 0.005]];

let cache: Row[] | null = null;

export function demoEnrollmentRows(): Row[] {
  return rows();
}

function rows(): Row[] {
  if (cache) return cache;
  const out: Row[] = [];
  for (const season of [2025, 2026]) {
    const start = campminderCalendar().range(season).start;
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
            camper: String(camperNo), // same ID every season, like real Campminder IDs
            family: `F${camperNo < 1000 ? Math.floor(camperNo / 2) : camperNo}`,
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
            ...demoHome(String(camperNo)),
            school: demoSchool(String(camperNo)),
            parentOccupations: demoOccupations(String(camperNo)),
            heardAbout: demoHeardAbout(`F${camperNo < 1000 ? Math.floor(camperNo / 2) : camperNo}`),
          });
        }
      }
    }
  }
  cache = out;
  return out;
}

/** Made-up answers to "How did you hear about us?", one per household. */
function demoHeardAbout(family: string): HeardAbout | null {
  const n = noise(`${family}heard`);
  const mix: Array<[number, HeardAbout]> = [[0.3, "Current Camper Family"], [0.2, "Web Search"], [0.12, "Instagram"], [0.1, "Facebook"], [0.08, "Current Staff Member"], [0.05, "Other"]];
  let acc = 0;
  return mix.find(([w]) => (acc += w) >= n)?.[1] ?? null; // the rest didn't answer
}

/** Same rules as familyStatusSql: new to the business line (first season enrolled), and the other line it came through first. */
let familyStatus: Map<string, { newFamily: string; cameThrough: string | null }> | null = null;
export function demoFamilyStatus(r: Pick<Row, "season" | "businessLine" | "family">): { newFamily: string; cameThrough: string | null } | null {
  if (!familyStatus) {
    type FL = { season: number; line: BusinessLineOrUnassigned; fam: string; maxYears: number; firstApp: string };
    const fl = new Map<string, FL>();
    for (const x of rows()) {
      if (x.statusCode !== "EN") continue;
      const k = `${x.season}|${x.businessLine}|${x.family}`;
      const f = fl.get(k) ?? { season: x.season, line: x.businessLine, fam: x.family, maxYears: 0, firstApp: x.applicationDate };
      f.maxYears = Math.max(f.maxYears, x.years);
      if (x.applicationDate < f.firstApp) f.firstApp = x.applicationDate;
      fl.set(k, f);
    }
    const all = [...fl.values()];
    const minSeason = Math.min(...all.map((f) => f.season));
    const first = new Map<string, number>();
    for (const f of all) first.set(`${f.line}|${f.fam}`, Math.min(first.get(`${f.line}|${f.fam}`) ?? Infinity, f.season));
    const byFam = new Map<string, FL[]>();
    for (const f of all) byFam.set(f.fam, [...(byFam.get(f.fam) ?? []), f]);
    familyStatus = new Map();
    for (const f of all) {
      const returning = f.season > first.get(`${f.line}|${f.fam}`)! || (f.season === minSeason && f.maxYears > 1);
      const before = (byFam.get(f.fam) ?? [])
        .filter((o) => o.line !== f.line && (o.season < f.season || (o.season === f.season && o.firstApp < f.firstApp)))
        .sort((a, b) => a.season - b.season || (a.firstApp < b.firstApp ? -1 : 1))[0];
      familyStatus.set(`${f.season}|${f.line}|${f.fam}`, {
        newFamily: returning ? RETURNING_FAMILY : NEW_FAMILY,
        cameThrough: returning ? null : before ? `${before.line === "unassigned" ? "unassigned" : BUSINESS_LINE_INFO[before.line].label} first` : "Directly",
      });
    }
  }
  return familyStatus.get(`${r.season}|${r.businessLine}|${r.family}`) ?? null;
}

/** Enrolled campers per household, season and business line (as the SQL's family_campers). */
let familySizes: Map<string, number> | null = null;
export function demoFamilyCampers(r: Pick<Row, "season" | "businessLine" | "family">): number {
  if (!familySizes) {
    const sets = new Map<string, Set<string>>();
    for (const x of rows()) {
      if (x.statusCode !== "EN") continue;
      const k = `${x.season}|${x.businessLine}|${x.family}`;
      sets.set(k, (sets.get(k) ?? new Set()).add(x.camper));
    }
    familySizes = new Map([...sets].map(([k, v]) => [k, v.size]));
  }
  return familySizes.get(`${r.season}|${r.businessLine}|${r.family}`) ?? 0;
}

/** Same as the SQL's FAMILY_BUCKET. */
export function familyBucket(n: number): string | null {
  return n <= 0 ? null : n === 1 ? "1 camper" : n >= 4 ? "4+ campers" : `${n} campers`;
}

/** Same rule as the SQL: each of the family's occupation categories, or UNKNOWN_KEY. */
const occupationKeys = (r: Row): string[] => (r.parentOccupations.length ? r.parentOccupations : [UNKNOWN_KEY]);

function keyOf(r: Row, d: Exclude<EnrollmentDimension, "week" | "occupation">, schools: SchoolMap): string {
  if (d === "school") return (r.school === null ? null : schools.has(r.school) ? schools.get(r.school)?.name : r.school) ?? UNKNOWN_KEY;
  return {
    family: familyBucket(demoFamilyCampers(r)) ?? UNKNOWN_KEY,
    session_group: r.sessionGroup, session: r.sessionName, program: r.program ?? UNKNOWN_KEY, age: String(r.age),
    grade: r.grade, gender: r.gender, years: String(r.years), state: r.state, status: r.status,
    new_family: demoFamilyStatus(r)?.newFamily ?? UNKNOWN_KEY,
    came_through: demoFamilyStatus(r)?.cameThrough ?? UNKNOWN_KEY,
    heard: r.heardAbout ?? UNKNOWN_KEY,
  }[d];
}

/** Same rule as the SQL: every filtered dimension must match. */
function matches(r: Row, f: EnrollmentFilters | undefined, schools: SchoolMap) {
  for (const [d, values] of Object.entries(f ?? {}) as Array<[EnrollmentDimension, string[]]>) {
    if (!values.length) continue;
    if (d === "week") {
      if (r.weekStart === null || !values.some((w) => Number(w) >= r.weekStart! && Number(w) <= r.weekEnd!)) return false;
    } else if (d === "occupation") {
      if (!occupationKeys(r).some((k) => values.includes(k))) return false;
    } else if (!values.includes(keyOf(r, d, schools))) return false;
  }
  return true;
}

const scoped = (bl: BusinessLineOrUnassigned | undefined, f?: EnrollmentFilters, schools: SchoolMap = new Map()) =>
  rows().filter((r) => (!bl || r.businessLine === bl) && matches(r, f, schools));

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
    ...familyCounts(en),
  };
}

/** Same as the SQL: families among these enrolled camper-sessions, those with 2+ campers, and their weeks together. */
function familyCounts(en: Row[]) {
  const campers = new Map<string, Set<string>>();
  const weeks = new Map<string, Set<string>>();
  for (const r of en) {
    campers.set(r.family, (campers.get(r.family) ?? new Set()).add(r.camper));
    if (r.weekStart === null) continue;
    for (let w = r.weekStart; w <= r.weekEnd!; w++) {
      const k = `${r.family}|${w}`;
      weeks.set(k, (weeks.get(k) ?? new Set()).add(r.camper));
    }
  }
  return {
    families: campers.size,
    new_families: [...new Set(en.filter((r) => demoFamilyStatus(r)?.newFamily === NEW_FAMILY).map((r) => r.family))].length,
    sibling_families: [...campers.values()].filter((s) => s.size >= 2).length,
    sibling_weeks_together: [...weeks.values()].filter((s) => s.size >= 2).length,
  };
}

export function demoEnrollmentSeasons(bl: BusinessLineOrUnassigned | undefined): EnrollmentSeason[] {
  const m = new Map<number, number>();
  for (const r of scoped(bl)) if (r.statusCode === "EN") m.set(r.season, (m.get(r.season) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([season, enrollments]) => ({ season, enrollments }));
}

export function demoEnrollmentSummary(q: EnrollmentSummaryQuery, seasons: SeasonCalendar, schools?: SchoolMap): EnrollmentSummaryResponse {
  const { asOf, prevCutoff, seasonStart } = enrollmentAsOf(q.season, seasons);
  const all = scoped(q.businessLine, q.filters, schools);
  const cur = all.filter((r) => r.season === q.season);
  const prev = all.filter((r) => r.season === q.season - 1 && r.applicationDate <= prevCutoff);
  const weeks = new Map<number, number>();
  for (const r of cur) if (r.statusCode === "EN" && r.weekStart !== null) for (let w = r.weekStart; w <= r.weekEnd!; w++) weeks.set(w, (weeks.get(w) ?? 0) + 1);
  const paceRows = new Map<string, { season: number; week_of_season: number; enrollments: number }>();
  for (const r of all) {
    if (r.statusCode !== "EN" || (r.season !== q.season && r.season !== q.season - 1)) continue;
    const start = seasons.range(r.season).start;
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

export function demoEnrollmentBreakdown(q: EnrollmentBreakdownQuery, schools: SchoolMap = new Map()): EnrollmentBreakdownResponse {
  const cur = scoped(q.businessLine, q.filters, schools).filter((r) => r.season === q.season);
  const groups = new Map<string, Row[]>();
  const add = (k: string, r: Row) => groups.set(k, [...(groups.get(k) ?? []), r]);
  for (const r of cur) {
    if (q.dimension === "week") {
      if (r.weekStart !== null) for (let w = r.weekStart; w <= r.weekEnd!; w++) add(String(w), r);
      continue;
    }
    if (q.dimension === "occupation") {
      for (const k of occupationKeys(r)) add(k, r);
      continue;
    }
    add(keyOf(r, q.dimension, schools), r);
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

export function demoEnrollmentMap(q: EnrollmentMapQuery, schools?: SchoolMap): EnrollmentMapResponse {
  const statusFiltered = (q.filters?.status ?? []).length > 0;
  const cur = scoped(q.businessLine, q.filters, schools).filter((r) => r.season === q.season && (statusFiltered || r.statusCode === "EN"));
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

/** One line of the demo Financial report (signed like Campminder's: charges and refunds +, credits and payments −). */
export interface DemoTransaction {
  transactionId: string;
  /** The camper-session it belongs to (demo rows), as the person and session tie it to an enrollment. */
  row: Row;
  season: number;
  businessLine: BusinessLineOrUnassigned;
  family: string;
  /** Who the line is under: the camper, or null for a parent (sibling discounts, like Campminder). */
  person: string | null;
  type: "debit" | "credit" | "payment" | "refund";
  category: string;
  sessionGroup: string;
  session: string;
  program: string | null;
  amount: number;
  postDate: string;
  serviceStart: string | null;
  method: string | null;
  /** Line item name on charges and credits ("Farm Week 3", "Week 3 Lunch", "Gear Bag"). */
  item: string | null;
  /** Item with the week folded in ("Week 3 Lunch" → "Lunch"), and the week. */
  itemGroup: string | null;
  itemWeek: number | null;
}

let txCache: DemoTransaction[] | null = null;

/** Demo transactions for every demo camper-session: a charge, sometimes a discount, payments, and refunds for cancellations. */
export function demoTransactions(): DemoTransaction[] {
  if (txCache) return txCache;
  const out: DemoTransaction[] = [];
  const category = (bl: BusinessLineOrUnassigned) => (bl === "camp" ? "Summer Camp" : bl === "chaps" ? "CHAPS" : "Extracurricular");
  rows().forEach((r, i) => {
    if (r.statusCode !== "EN" && r.statusCode !== "CN") return;
    const price = r.weekStart !== null ? 650 : 400;
    const id = `D${i}`;
    const serviceStart = r.weekStart !== null ? addDays(`${r.season}-06-22`, 7 * (r.weekStart - 1)) : null;
    const base = {
      row: r,
      season: r.season,
      businessLine: r.businessLine,
      family: r.camper,
      person: r.camper as string | null,
      category: category(r.businessLine),
      sessionGroup: r.sessionGroup,
      session: r.sessionName,
      program: r.program,
      postDate: r.applicationDate,
      serviceStart,
    };
    const noItem = { item: null, itemGroup: null, itemWeek: null };
    out.push({ ...base, ...noItem, transactionId: id, type: "debit", amount: price, method: null, item: r.sessionName, itemGroup: r.sessionName });
    const n = noise(`${id}fin`);
    const discount = n < 0.12 ? Math.round(price * 0.15) : 0;
    if (discount) out.push({ ...base, ...noItem, transactionId: `${id}c`, type: "credit", amount: -discount, method: null, item: "Sibling discount", itemGroup: "Sibling discount", person: null });
    // Camp extras: lunch for some weeks (on the session's own line), a gear bag or backpack now and then.
    let extras = 0;
    if (r.businessLine === "camp" && r.statusCode === "EN") {
      const extra = (suffix: string, item: string, amount: number, week: number | null, category = base.category) => {
        extras += amount;
        const itemGroup = week === null ? item : item.replace(/\bweek\s*\d{1,2}\b/i, "").replace(/\s+/g, " ").trim();
        // Like Campminder: a Miscellaneous line is its own (unassigned) business line, whatever session it names.
        const businessLine = category === "Miscellaneous" ? ("unassigned" as const) : base.businessLine;
        out.push({ ...base, businessLine, transactionId: `${id}${suffix}`, type: "debit", amount, method: null, category, item, itemGroup, itemWeek: week });
      };
      if (r.weekStart !== null && noise(`${id}lunch`) < 0.35) extra("L", `Week ${r.weekStart} Lunch`, 45, r.weekStart);
      const g = noise(`${id}gear`);
      if (g < 0.06) extra("G", "Gear Bag", 35, null);
      else if (g < 0.1) extra("B", "Backpack", 28, null);
      if (noise(`${id}fee`) < 0.02) extra("F", "Summer Camp Cancellation Fee", 50, null);
      if (noise(`${id}misc`) < 0.02) extra("M", "Airline Charge", 120, null, "Miscellaneous"); // like Campminder: not a Summer Camp item
    }
    // Most pay in full; some still owe part; cancellations are refunded.
    const due = price - discount + extras;
    const paid = n > 0.93 && r.statusCode === "EN" ? Math.round(due / 2) : due;
    const method = n < 0.6 ? "Credit Card" : n < 0.85 ? "ACH" : "Check";
    out.push({ ...base, ...noItem, transactionId: `${id}p`, type: "payment", amount: -paid, postDate: addDays(r.applicationDate, 3), method });
    if (r.statusCode === "CN") out.push({ ...base, ...noItem, transactionId: `${id}r`, type: "refund", amount: paid, postDate: addDays(r.applicationDate, 30), method });
  });
  txCache = out;
  return out;
}

export function demoCampminderFinance(q: CampminderFinanceQuery, schools: SchoolMap = new Map()): CampminderFinanceSummary {
  const filtered = Object.values(q.filters ?? {}).some((v) => v && v.length > 0);
  const txs = demoTransactions().filter(
    (t) => t.season === q.season && (!q.businessLine || t.businessLine === q.businessLine) && (!filtered || matches(t.row, q.filters, schools)),
  );
  const sum = (type: DemoTransaction["type"]) => txs.filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0);
  const balances = new Map<string, number>();
  for (const t of txs) balances.set(t.family, (balances.get(t.family) ?? 0) + t.amount);
  const owed = [...balances.values()].filter((b) => b > 0.005);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const charges = sum("debit");
  const discounts = -sum("credit");
  const payments = -sum("payment");
  const refunds = sum("refund");
  return {
    season: q.season,
    businessLine: q.businessLine ?? null,
    charges: r2(charges),
    discounts: r2(discounts),
    netTuition: r2(charges - discounts),
    payments: r2(payments),
    refunds: r2(refunds),
    netCollected: r2(payments - refunds),
    balanceOwed: r2(owed.reduce((a, b) => a + b, 0)),
    householdsOwing: owed.length,
    creditHeld: r2(-[...balances.values()].filter((b) => b < -0.005).reduce((a, b) => a + b, 0)),
    households: balances.size,
    filtered,
  };
}

/** Same rule as campminderExtrasSql: Summer Camp charges and credits for the chosen items, last season up to `cutoff`. */
export function demoCampminderExtras(q: CampminderExtrasQuery, cutoff: string, items: string[]): CampminderExtrasRow[] {
  const groups = new Map<string, CampminderExtrasRow>();
  for (const t of demoTransactions()) {
    if ((t.type !== "debit" && t.type !== "credit") || !t.itemGroup || t.category !== CAMP_EXTRAS_CATEGORY || !items.includes(t.itemGroup)) continue;
    if (q.businessLine && t.businessLine !== q.businessLine) continue;
    if (!(t.season === q.season || (t.season === q.season - 1 && t.postDate <= cutoff))) continue;
    const k = JSON.stringify([t.season, t.itemGroup, t.itemWeek, t.sessionGroup]);
    const g = groups.get(k) ?? { season: t.season, item: t.itemGroup, week: t.itemWeek, sessionGroup: t.sessionGroup, count: 0, revenue: 0 };
    g.count += t.type === "debit" ? 1 : 0;
    g.revenue += t.amount;
    groups.set(k, g);
  }
  return [...groups.values()];
}

/** Same as campLineItemsSql: every Summer Camp line item with its lines and net amount. */
export function demoCampLineItems(): CampLineItem[] {
  const items = new Map<string, CampLineItem>();
  for (const t of demoTransactions()) {
    if ((t.type !== "debit" && t.type !== "credit") || !t.itemGroup || t.category !== CAMP_EXTRAS_CATEGORY) continue;
    const i = items.get(t.itemGroup) ?? { item: t.itemGroup, lines: 0, amount: 0 };
    i.lines++;
    i.amount = Math.round((i.amount + t.amount) * 100) / 100;
    items.set(t.itemGroup, i);
  }
  return [...items.values()].sort((a, b) => b.lines - a.lines);
}

/** Same rule as registrationPaceSql: each family's wave from last season's camp locations, then days since it opened. */
export function demoRegistrationPace(q: RegistrationPaceQuery, registration: RegistrationSettings, schools: SchoolMap = new Map()): RegistrationPaceResponse {
  const opens = registration.opens;
  const prev = new Map<string, Set<string>>();
  for (const r of rows()) {
    const loc = registration.locations[r.sessionGroup];
    if (r.statusCode !== "EN" || !loc) continue;
    const k = `${r.season + 1}|${r.family}`;
    prev.set(k, (prev.get(k) ?? new Set()).add(loc));
  }
  const waveOf = (season: number, family: string): RegistrationPaceRow["wave"] => {
    const locs = [...(prev.get(`${season}|${family}`) ?? [])].filter((l) => opens[season]?.[l as "va" | "md"]);
    locs.sort((a, b) => (opens[season]![a as "va"]! < opens[season]![b as "va"]! ? -1 : opens[season]![a as "va"]! > opens[season]![b as "va"]! ? 1 : a < b ? -1 : 1));
    return (locs[0] as RegistrationPaceRow["wave"] | undefined) ?? "new";
  };
  const groups = new Map<string, { row: RegistrationPaceRow; campers: Set<string> }>();
  for (const r of scoped(q.businessLine, q.filters, schools)) {
    if (r.statusCode !== "EN" || !r.applicationDate) continue;
    const wave = waveOf(r.season, r.family);
    const open = opens[r.season]?.[wave];
    if (!open) continue;
    const day = Math.max(-1, Math.round((Date.parse(`${r.applicationDate}T00:00:00Z`) - Date.parse(`${open}T00:00:00Z`)) / 86_400_000));
    const k = `${r.season}|${wave}|${day}`;
    const g = groups.get(k) ?? { row: { season: r.season, wave, day, enrollments: 0, campers: 0 }, campers: new Set() };
    g.row.enrollments++;
    g.campers.add(r.camper);
    groups.set(k, g);
  }
  return { rows: [...groups.values()].map((g) => ({ ...g.row, campers: g.campers.size })) };
}

/** Same rule as returningFamiliesSql: households at a camp location last season, and what they did in Camp this season. */
export function demoReturningFamilies(locations: RegistrationSettings["locations"], seasons: number[]): ReturningFamilyFacts[] {
  type Last = { locations: Set<CampLocation>; groups: Map<string, number>; weeks: number; summers: number | null; state: string; zip: string; campers: Map<string, number> };
  const last = new Map<string, Last>();
  for (const r of rows()) {
    const loc = locations[r.sessionGroup];
    const season = r.season + 1;
    if (r.statusCode !== "EN" || !loc || (seasons.length && !seasons.includes(season))) continue;
    const k = `${season}|${r.family}`;
    const f = last.get(k) ?? { locations: new Set(), groups: new Map(), weeks: 0, summers: null, state: r.state, zip: r.zip, campers: new Map() };
    const weeks = r.weekStart !== null ? r.weekEnd! - r.weekStart + 1 : 1;
    f.locations.add(loc);
    f.groups.set(r.sessionGroup, (f.groups.get(r.sessionGroup) ?? 0) + weeks);
    f.weeks += weeks;
    f.summers = Math.max(f.summers ?? 0, r.years);
    f.campers.set(r.camper, Math.max(f.campers.get(r.camper) ?? 0, r.age));
    last.set(k, f);
  }
  type Now = { enrolled: boolean; waitlisted: boolean; cancelled: boolean; enrolledOn: string | null };
  const now = new Map<string, Now>();
  const enrolledCampers = new Set<string>();
  for (const r of rows()) {
    if (r.businessLine !== "camp") continue;
    const k = `${r.season}|${r.family}`;
    const n = now.get(k) ?? { enrolled: false, waitlisted: false, cancelled: false, enrolledOn: null };
    if (r.statusCode === "EN") {
      n.enrolled = true;
      if (!n.enrolledOn || r.applicationDate < n.enrolledOn) n.enrolledOn = r.applicationDate;
      enrolledCampers.add(`${r.season}|${r.camper}`);
    }
    if (r.statusCode === "WL" || r.statusCode === "AP") n.waitlisted = true;
    if (r.statusCode === "CN" || r.statusCode === "WD") n.cancelled = true;
    now.set(k, n);
  }
  return [...last].map(([k, f]) => {
    const [season, family] = [Number(k.split("|")[0]), k.slice(k.indexOf("|") + 1)];
    const n = now.get(k);
    const groups = [...f.groups].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return {
      season,
      household: family.slice(0, 10),
      locations: [...f.locations].sort(),
      sessionGroup: groups[0]![0],
      weeks: f.weeks,
      summers: f.summers,
      state: f.state,
      zip: f.zip,
      campers: [...f.campers].map(([camper, age]) => ({ age, enrolled: enrolledCampers.has(`${season}|${camper}`) })),
      enrolled: n?.enrolled ?? false,
      waitlisted: n?.waitlisted ?? false,
      cancelled: n?.cancelled ?? false,
      enrolledOn: n?.enrolledOn ?? null,
    };
  });
}

/** Same as returningFamiliesCountSql. */
export function demoReturningFamilyCounts(groups: string[]): Array<{ season: number; families: number }> {
  const sets = new Map<number, Set<string>>();
  for (const r of rows()) {
    if (r.statusCode !== "EN" || !groups.includes(r.sessionGroup)) continue;
    sets.set(r.season + 1, (sets.get(r.season + 1) ?? new Set()).add(r.family));
  }
  return [...sets].map(([season, s]) => ({ season, families: s.size }));
}

/**
 * Same rules as camperTuitionCtes: each charge and discount line given to
 * campers (under a camper: theirs; else split across the household's enrolled
 * campers in its session, or its business line without one, by their charges).
 */
export interface DemoTuitionAlloc {
  season: number;
  businessLine: BusinessLineOrUnassigned;
  camper: string | null;
  session: string | null;
  enrolled: boolean;
  tuition: number;
  extras: number;
}

export function demoTuitionAlloc(
  extras: string[],
  keepTx: (t: DemoTransaction) => boolean = () => true,
  keepEnr: (r: Row) => boolean = () => true,
): DemoTuitionAlloc[] {
  const enr = rows().filter(keepEnr);
  const campers = new Set(enr.map((r) => `${r.season}|${r.camper}`));
  const enrolledIn = new Set(enr.filter((r) => r.statusCode === "EN").map((r) => `${r.season}|${r.businessLine}|${r.camper}`));
  const enrolledInSession = new Set(enr.filter((r) => r.statusCode === "EN").map((r) => `${r.season}|${r.camper}|${r.sessionName}`));
  const txs = demoTransactions().filter((t) => (t.type === "debit" || t.type === "credit") && keepTx(t));
  const isExtra = (t: DemoTransaction) => t.category === CAMP_EXTRAS_CATEGORY && !!t.itemGroup && extras.includes(t.itemGroup);
  const isDirect = (t: DemoTransaction) => t.person !== null && campers.has(`${t.season}|${t.person}`);
  const direct = txs.filter(isDirect);
  const other = txs.filter((t) => !isDirect(t));
  const wSession = new Map<string, number>();
  const wLine = new Map<string, number>();
  for (const t of direct) {
    if (t.type !== "debit") continue;
    if (t.session) wSession.set(`${t.season}|${t.person}|${t.session}`, (wSession.get(`${t.season}|${t.person}|${t.session}`) ?? 0) + t.amount);
    wLine.set(`${t.season}|${t.person}|${t.businessLine}`, (wLine.get(`${t.season}|${t.person}|${t.businessLine}`) ?? 0) + t.amount);
  }
  // The household's enrolled campers by session and by business line.
  const bySession = new Map<string, Set<string>>();
  const byLine = new Map<string, Set<string>>();
  for (const r of enr) {
    if (r.statusCode !== "EN") continue;
    const ks = `${r.season}|${r.family}|${r.sessionName}`;
    const kl = `${r.season}|${r.family}|${r.businessLine}`;
    bySession.set(ks, (bySession.get(ks) ?? new Set()).add(r.camper));
    byLine.set(kl, (byLine.get(kl) ?? new Set()).add(r.camper));
  }
  const given: Array<{ t: DemoTransaction; camper: string | null; amount: number }> = direct.map((t) => ({ t, camper: t.person, amount: t.amount }));
  for (const t of other) {
    const household = t.row.family;
    const cands = [...((t.session ? bySession.get(`${t.season}|${household}|${t.session}`) : byLine.get(`${t.season}|${household}|${t.businessLine}`)) ?? [])];
    if (!cands.length) {
      given.push({ t, camper: null, amount: t.amount });
      continue;
    }
    const w = cands.map((c) => Math.max(0, (t.session ? wSession.get(`${t.season}|${c}|${t.session}`) : wLine.get(`${t.season}|${c}|${t.businessLine}`)) ?? 0));
    const total = w.reduce((a, b) => a + b, 0);
    cands.forEach((c, i) => given.push({ t, camper: c, amount: t.amount * (total > 0 ? w[i]! / total : 1 / cands.length) }));
  }
  const out = new Map<string, DemoTuitionAlloc>();
  for (const g of given) {
    const k = `${g.t.season}|${g.t.businessLine}|${g.camper}|${g.t.session}`;
    const a = out.get(k) ?? {
      season: g.t.season,
      businessLine: g.t.businessLine,
      camper: g.camper,
      session: g.t.session,
      enrolled:
        g.camper !== null &&
        enrolledIn.has(`${g.t.season}|${g.t.businessLine}|${g.camper}`) &&
        (!g.t.session || enrolledInSession.has(`${g.t.season}|${g.camper}|${g.t.session}`)),
      tuition: 0,
      extras: 0,
    };
    if (isExtra(g.t)) a.extras += g.amount;
    else a.tuition += g.amount;
    out.set(k, a);
  }
  return [...out.values()];
}

/** Same as camperTuitionCardSql. */
export function demoCamperTuition(q: CampminderFinanceQuery, ctx: { prevCutoff: string; extras: string[] }, schools: SchoolMap = new Map()): CamperTuitionResponse {
  const filtered = Object.values(q.filters ?? {}).some((v) => v && v.length > 0);
  const inPair = (season: number, date: string | null) => season === q.season || (season === q.season - 1 && (date === null || date <= ctx.prevCutoff));
  const alloc = demoTuitionAlloc(ctx.extras, (t) => inPair(t.season, t.postDate), (r) => inPair(r.season, r.applicationDate));
  const line = (bl: BusinessLineOrUnassigned) => !q.businessLine || bl === q.businessLine;
  const kept = rows().filter((r) => r.statusCode === "EN" && line(r.businessLine) && inPair(r.season, r.applicationDate) && (!filtered || matches(r, q.filters, schools)));
  const keptSessions = new Set(kept.map((r) => `${r.season}|${r.camper}|${r.sessionName}`));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const of = (season: number): CamperTuition => {
    const mine = alloc.filter((a) => a.season === season && line(a.businessLine));
    const counted = filtered ? mine.filter((a) => a.camper !== null && keptSessions.has(`${season}|${a.camper}|${a.session}`)) : mine.filter((a) => a.enrolled);
    const k = kept.filter((r) => r.season === season);
    return {
      campers: new Set(k.map((r) => r.camper)).size,
      weeks: k.reduce((t, r) => t + (r.weekStart !== null ? r.weekEnd! - r.weekStart + 1 : 0), 0),
      tuition: r2(counted.reduce((t, a) => t + a.tuition, 0)),
      extras: r2(counted.reduce((t, a) => t + a.extras, 0)),
      notPerCamper: filtered ? 0 : r2(mine.filter((a) => !a.enrolled).reduce((t, a) => t + a.tuition + a.extras, 0)),
      lines: demoTransactions().filter((t) => (t.type === "debit" || t.type === "credit") && t.season === season && line(t.businessLine) && inPair(t.season, t.postDate)).length,
    };
  };
  const previous = of(q.season - 1);
  return {
    season: q.season,
    businessLine: q.businessLine ?? null,
    filtered,
    current: of(q.season),
    previous: previous.lines > 0 ? previous : null,
    previousCutoff: ctx.prevCutoff >= "9999" ? null : ctx.prevCutoff,
  };
}
