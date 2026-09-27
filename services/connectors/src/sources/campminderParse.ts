import { createHash } from "node:crypto";
import { seasonForDate } from "@dash/shared";
import { pseudonymize } from "../core/privacy.js";
import { addressKey, homeAddress, zip5, type GeoResult } from "./geocode.js";

/**
 * Turns Campminder's one-row-per-camper report into one row per
 * camper-session, keeping only allow-listed, non-identifying fields.
 *
 * The report lists sessions as "A[EN], B[CN] and C[EN]". Session and program
 * names can themselves contain " and " ("Fall Farm and Forest Cubs"), so the
 * status column is split on the [CODE] markers, never on the word "and".
 */

export const STATUS_LABEL: Record<string, string> = {
  EN: "Enrolled",
  CN: "Cancelled",
  WD: "Withdrawn",
  WL: "Waitlisted",
  AP: "Applied",
  DM: "Dismissed",
  LE: "Left early",
};

export interface CampminderSession {
  season: number;
  camperHash: string;
  familyHash: string | null;
  sessionName: string;
  /** Session name without its week ("Farm Week 9" → "Farm"); what business lines are assigned by. */
  sessionGroup: string;
  isWeekly: boolean;
  weekStart: number | null;
  weekEnd: number | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  program: string | null;
  statusCode: string;
  status: string;
  gender: string | null;
  ageAtSeason: number | null;
  campGrade: string | null;
  schoolGrade: string | null;
  yearsAsCamper: number | null;
  applicationDate: string | null;
  statusPostDate: string | null;
  statusEffectiveDate: string | null;
  homeState: string | null;
  /** 5-digit ZIP and home coordinates (from the address, which isn't kept). */
  homeZip: string | null;
  homeLat: number | null;
  homeLon: number | null;
  /** Changes when any stored field changes; used to write only what changed. */
  rowHash: string;
}

/** "7/4/2026" or "07/04/2026" → "2026-07-04"; anything else → null. */
export function usDate(v: string | undefined): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(v ?? "");
  if (!m) return null;
  const [, mo, d, y] = m;
  const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** Parse "Name[EN], Other Name[CN] and Last[EN]" into name/code pairs. */
export function parseSessionStatuses(v: string): Array<{ name: string; code: string }> {
  const out: Array<{ name: string; code: string }> = [];
  const re = /(.+?)\[([A-Z]{1,4})\](?:\s*,\s*|\s+and\s+|\s*$)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v.trim())) !== null) out.push({ name: m[1]!.trim(), code: m[2]! });
  return out;
}

/** "Farm Week 9" → { group: "Farm", start: 9, end: 9 }; "Madeira Weeks 5-6" → 5..6. */
export function parseWeek(name: string): { group: string; start: number | null; end: number | null } {
  const m = /^(.*?)\s+Weeks?\s+(\d+)(?:\s*-\s*(\d+))?\s*$/i.exec(name);
  if (!m) return { group: name, start: null, end: null };
  const start = Number(m[2]);
  return { group: m[1]!.trim(), start, end: m[3] ? Number(m[3]) : start };
}

/** Dates from the newline-separated "Sessions With Dates (columnar)" column. */
export function parseSessionDates(v: string): Map<string, { start: string; end: string }> {
  const out = new Map<string, { start: string; end: string }>();
  for (const line of v.split(/\r?\n/)) {
    const m = /^(.+?)\s+\((\d{1,2}\/\d{1,2}\/\d{4})-(\d{1,2}\/\d{1,2}\/\d{4})\)\s*$/.exec(line.trim());
    const start = m ? usDate(m[2]) : null;
    const end = m ? usDate(m[3]) : null;
    if (m && start && end) out.set(m[1]!.trim(), { start, end });
  }
  return out;
}

/**
 * Programs from "Session A/Program X, Session B/Program Y and Session C/Program Z".
 * Located by the known session names (which may contain commas or "and").
 */
export function parseSessionPrograms(v: string, sessionNames: string[]): Map<string, string> {
  const hits = sessionNames
    .map((name) => ({ name, at: v.indexOf(`${name}/`) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);
  const out = new Map<string, string>();
  hits.forEach((h, i) => {
    const from = h.at + h.name.length + 1;
    const to = i + 1 < hits.length ? hits[i + 1]!.at : v.length;
    const program = v.slice(from, to).replace(/(\s*,\s*|\s+and\s+)$/, "").trim();
    if (program) out.set(h.name, program);
  });
  return out;
}

function ageOn(birth: string | null, onIso: string): number | null {
  if (!birth) return null;
  const [by, bm, bd] = birth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = onIso.split("-").map(Number) as [number, number, number];
  const age = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return age >= 0 && age < 30 ? age : null;
}

const clean = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t && t !== "Undefined" ? t : null;
};

/** Season a report covers: the season of its latest session start (or latest application). */
export function reportSeason(rows: Array<Record<string, string>>): number | null {
  let latest: string | null = null;
  for (const r of rows) {
    for (const { start } of parseSessionDates(r["Enrolled Child Sessions With Dates (columnar)"] ?? "").values()) {
      if (!latest || start > latest) latest = start;
    }
  }
  if (!latest) {
    for (const r of rows) {
      const a = usDate(r["Child Application Date"]);
      if (a && (!latest || a > latest)) latest = a;
    }
  }
  return latest ? seasonForDate(latest) : null;
}

/**
 * Convert report rows (header → value) into camper-session rows. Only the
 * fields listed on CampminderSession leave this function.
 */
export function toSessions(
  rows: Array<Record<string, string>>,
  key: string,
  season: number,
  /** Home coordinates by addressKey(); see geocode.ts. */
  homes: Map<string, GeoResult> = new Map(),
): CampminderSession[] {
  // Session dates are the same for every camper; collect them across the report
  // so cancelled sessions (not in a camper's own dates column) get dates too.
  const dates = new Map<string, { start: string; end: string }>();
  for (const r of rows) for (const [k, v] of parseSessionDates(r["Enrolled Child Sessions With Dates (columnar)"] ?? "")) dates.set(k, v);

  const out = new Map<string, CampminderSession>();
  for (const r of rows) {
    const personId = clean(r["PersonID"]);
    if (!personId) continue;
    const statuses = parseSessionStatuses(r["Child Session/Status"] ?? "");
    const programs = parseSessionPrograms(r["Enrolled Child Sessions/Programs"] ?? "", statuses.map((s) => s.name));
    const birth = usDate(r["Birth Date"]);
    const years = Number(clean(r["Years as Child Camper"]));
    const base = {
      season,
      camperHash: pseudonymize(personId, key)!,
      familyHash: pseudonymize(clean(r["Primary Childhood ID"]), key),
      gender: clean(r["Gender"]),
      ageAtSeason: ageOn(birth, `${season}-06-01`),
      campGrade: clean(r["Camp Grade"]),
      schoolGrade: clean(r["School Grade"]),
      yearsAsCamper: Number.isFinite(years) && years > 0 ? years : null,
      applicationDate: usDate(r["Child Application Date"]),
      statusPostDate: usDate(r["Child Status Post Date"]),
      statusEffectiveDate: usDate(r["Child Status Effective Date"]),
      homeState: clean(r["Primary Childhood HomeState"]),
      homeZip: zip5(r["Primary Childhood HomeZip"]),
      ...homeCoords(r, key, homes),
    };
    for (const s of statuses) {
      const w = parseWeek(s.name);
      const d = dates.get(s.name);
      const row = {
        ...base,
        sessionName: s.name,
        sessionGroup: w.group,
        isWeekly: w.start !== null,
        weekStart: w.start,
        weekEnd: w.end,
        sessionStart: d?.start ?? null,
        sessionEnd: d?.end ?? null,
        program: programs.get(s.name) ?? null,
        statusCode: s.code,
        status: STATUS_LABEL[s.code] ?? s.code,
      };
      const session = { ...row, rowHash: createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 16) };
      // A session listed twice (say cancelled, then re-enrolled) keeps its most current status.
      const id = sessionRecordId(session);
      const prev = out.get(id);
      if (!prev || statusRank(session.statusCode) < statusRank(prev.statusCode)) out.set(id, session);
    }
  }
  return [...out.values()];
}

/** Lower wins: attended beats waiting, which beats cancelled or withdrawn. */
const STATUS_RANK = ["EN", "LE", "DM", "WL", "AP"];
function statusRank(code: string) {
  const i = STATUS_RANK.indexOf(code);
  return i === -1 ? STATUS_RANK.length : i;
}

function homeCoords(r: Record<string, string>, key: string, homes: Map<string, GeoResult>) {
  const a = homeAddress(r);
  const loc = a ? homes.get(addressKey(a, key)) : null;
  return { homeLat: loc?.lat ?? null, homeLon: loc?.lon ?? null };
}

export function sessionRecordId(s: Pick<CampminderSession, "season" | "camperHash" | "sessionName">): string {
  return `${s.season}|${s.camperHash}|${s.sessionName}`;
}
