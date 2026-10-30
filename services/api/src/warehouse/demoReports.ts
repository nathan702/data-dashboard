import {
  addDays,
  campminderCalendar,
  draftProgramFamily,
  NONE_VALUE,
  type ProgramFamilySettings,
  type ReportResult,
  type ReportSpec,
} from "@dash/shared";
import { effectiveFilters, type SchoolMap } from "./reportSql.js";
import { toReportResult } from "./reportResult.js";
import { DEMO_STREAMS, demoRow } from "./demo.js";
import { demoEnrollmentRows } from "./demoCampminder.js";
import { demoLineKey, demoLines } from "./demoRetail.js";

/**
 * The report builder over demo data: the same data sets, fields and measures
 * as reportSql.ts, computed in memory (local development and tests).
 */
type Rec = Record<string, unknown>;
type Measure = (rs: Rec[]) => number | null;

const distinct = (rs: Rec[], k: string, where: (r: Rec) => boolean = () => true) => new Set(rs.filter(where).map((r) => r[k])).size;
const avg = (rs: Rec[], k: string) => {
  const xs = rs.map((r) => r[k]).filter((x): x is number => typeof x === "number");
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const sum = (rs: Rec[], k: string) => rs.reduce((t, r) => t + Number(r[k] ?? 0), 0);
const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = (d: string) => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]!;

/** Same rule as the SQL: the resolved school, or the spelling itself when it isn't in the map. */
function demoSchoolFields(entered: string | null, schools: SchoolMap) {
  const s = entered === null ? null : schools.has(entered) ? schools.get(entered)! : { name: entered, type: null, state: null, county: null };
  const label = { public: "Public", private: "Private", other: "Other" } as const;
  return { school: s?.name ?? null, school_type: s?.type ? label[s.type] : null, school_state: s?.state ?? null, school_county: s?.county ?? null };
}

function familyOf(program: string | null, pf: ProgramFamilySettings) {
  if (!program) return { family: null, branch: null };
  return pf.overrides[program] ?? draftProgramFamily(program);
}

/** Monday of the week a date falls in (YYYY-MM-DD). */
const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
/** Demo sessions run weekly from late June. */
const demoSessionStart = (season: number, week: number | null) => (week === null ? null : addDays(`${season}-06-22`, 7 * (week - 1)));

function signupFields(applicationDate: string | null) {
  return {
    application_date: applicationDate,
    signup_month: applicationDate?.slice(0, 7) ?? null,
    signup_week: applicationDate ? mondayOf(applicationDate) : null,
  };
}

function enrollmentRecords(pf: ProgramFamilySettings, schools: SchoolMap, explodeWeeks: boolean): Rec[] {
  const out: Rec[] = [];
  for (const r of demoEnrollmentRows()) {
    const fam = familyOf(r.program, pf);
    const base: Rec = {
      season: String(r.season),
      business_line: r.businessLine,
      camper: r.camper,
      camper_id: r.camper,
      years_at_camp: String(r.years),
      years: r.years,
      new_or_returning: r.years === 1 ? "New" : "Returning",
      age: String(r.age),
      grade: r.grade,
      ...demoSchoolFields(r.school, schools),
      school_as_entered: r.school,
      parent_occupations: r.parentOccupations,
      gender: r.gender,
      state: r.state,
      zip: r.zip,
      session_group: r.sessionGroup,
      session: r.sessionName,
      program: r.program,
      program_family: fam.family,
      program_branch: fam.branch,
      status: r.status,
      status_code: r.statusCode,
      week_start: r.weekStart,
      week_end: r.weekEnd,
      week_list: r.weekStart === null ? [] : range(r.weekStart, r.weekEnd!).map(String),
      ...signupFields(r.applicationDate),
      weeks_before_session: weeksBefore(r.applicationDate, demoSessionStart(r.season, r.weekStart)),
    };
    if (explodeWeeks && r.weekStart !== null) for (let w = r.weekStart; w <= r.weekEnd!; w++) out.push({ ...base, week: String(w) });
    else out.push({ ...base, week: null });
  }
  return out;
}

const EN = (r: Rec) => r.status_code === "EN";

function weeksBefore(applied: string | null, start: string | null) {
  if (!applied || !start) return null;
  const days = (Date.parse(`${start}T00:00:00Z`) - Date.parse(`${applied}T00:00:00Z`)) / 86_400_000;
  return String(Math.floor(days / 7));
}

function camperGroups(pf: ProgramFamilySettings, schools: SchoolMap, byFamily: boolean): Rec[] {
  const groups = new Map<string, Rec[]>();
  for (const r of enrollmentRecords(pf, schools, false)) {
    if (!EN(r) || (byFamily && !r.program_family)) continue;
    const k = [r.season, r.business_line, r.camper_id, byFamily ? r.program_family : ""].join("|");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    const a = rs[0]!;
    const applied = rs.map((r) => r.application_date as string | null).filter((d): d is string => !!d).sort()[0] ?? null;
    return { ...a, ...signupFields(applied), years_at_camp: String(Math.max(...rs.map((r) => Number(r.years)))), rs };
  });
}

const distinctValues = (rs: Rec[], k: string) => [...new Set(rs.map((r) => r[k]).filter((v): v is string => typeof v === "string"))];
function range(a: number, b: number) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** Same as the SQL's multi-valued fields: field id → array property. */
const CAMPER_MULTI: Record<string, string> = { parent_occupation: "parent_occupations" };
const MULTI: Partial<Record<ReportSpec["dataset"], Record<string, string>>> = {
  enrollments: CAMPER_MULTI,
  camper_seasons: {
    ...CAMPER_MULTI,
    session_group: "attended_session_groups",
    session: "attended_sessions",
    program: "attended_programs",
    program_family: "attended_program_families",
    week: "attended_weeks",
    also_business_line: "other_business_lines",
  },
  program_families: CAMPER_MULTI,
};

function camperSeasonRecords(pf: ProgramFamilySettings, schools: SchoolMap): Rec[] {
  const recs: Rec[] = camperGroups(pf, schools, false).map((g): Rec => {
    const rs = g.rs as Rec[];
    const weekly = rs.filter((r) => r.week_start !== null);
    return {
      ...g,
      sessions_n: rs.length,
      weeks_n: weekly.reduce((t, r) => t + Number(r.week_end) - Number(r.week_start) + 1, 0),
      sessions: String(rs.length),
      weeks: String(weekly.reduce((t, r) => t + Number(r.week_end) - Number(r.week_start) + 1, 0)),
      first_week: weekly.length ? String(Math.min(...weekly.map((r) => Number(r.week_start)))) : null,
      last_week: weekly.length ? String(Math.max(...weekly.map((r) => Number(r.week_end)))) : null,
      programs: String(new Set(rs.map((r) => r.program)).size),
      attended_session_groups: distinctValues(rs, "session_group"),
      attended_sessions: distinctValues(rs, "session"),
      attended_programs: distinctValues(rs, "program"),
      attended_program_families: distinctValues(rs, "program_family"),
      attended_weeks: [...new Set(weekly.flatMap((r) => range(Number(r.week_start), Number(r.week_end)).map(String)))],
      session_list: rs.map((r) => ({ session_group: r.session_group, session: r.session, program: r.program, program_family: r.program_family, weeks: r.week_list })),
    };
  });
  const key = (r: Rec, season: number) => `${r.camper_id}|${r.business_line}|${season}`;
  const bySeason = new Map(recs.map((r) => [key(r, Number(r.season)), r]));
  const newest = Math.max(...recs.map((r) => Number(r.season)));
  // Business lines per camper and season; cancelled or withdrawn sessions per camper, season and line.
  const lines = new Map<string, Set<string>>();
  for (const r of recs) {
    const k = `${r.camper_id}|${r.season}`;
    lines.set(k, (lines.get(k) ?? new Set()).add(String(r.business_line)));
  }
  const cancels = new Map<string, number>();
  for (const r of enrollmentRecords(pf, schools, false)) {
    if (r.status_code === "CN" || r.status_code === "WD") cancels.set(key(r, Number(r.season)), (cancels.get(key(r, Number(r.season))) ?? 0) + 1);
  }
  return recs.map((r) => {
    const next = Number(r.season) >= newest ? null : bySeason.get(key(r, Number(r.season) + 1)) ?? false;
    const returned = next === null ? null : next !== false;
    const nextGroups = next ? (next.attended_session_groups as string[]) : [];
    const cancelled = cancels.get(key(r, Number(r.season))) ?? 0;
    return {
      ...r,
      returned_flag: returned,
      returned: returned === null ? "Not known yet" : returned ? "Returned" : "Didn't return",
      returned_groups: next === null ? null : (r.attended_session_groups as string[]).filter((g) => nextGroups.includes(g)),
      other_business_lines: [...(lines.get(`${r.camper_id}|${r.season}`) ?? [])].filter((l) => l !== r.business_line),
      cancelled_sessions: cancelled,
      cancellations: cancelled > 0 ? "Cancelled or withdrew a session" : "No cancellations",
    };
  });
}

function familyRecords(pf: ProgramFamilySettings, schools: SchoolMap): Rec[] {
  return camperGroups(pf, schools, true).map((g) => {
    const branches = [...new Set((g.rs as Rec[]).map((r) => (r.program_branch as string | null) ?? "(base program)"))].sort();
    return { ...g, branches_n: branches.length, branches: String(branches.length), branch_combination: branches.join(" + ") };
  });
}

function revenueRecords(start: string, end: string): Rec[] {
  const out: Rec[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    for (const s of DEMO_STREAMS) {
      for (const basis of ["service", "booked", "collected"] as const) {
        const row = demoRow(s, d, basis);
        out.push({
          business_line: s.businessLine,
          source: s.source,
          year: d.slice(0, 4),
          month: d.slice(0, 7),
          weekday: weekday(d),
          date: d,
          date_basis: basis === "service" ? "Program / service date" : basis === "booked" ? "Date booked" : "Date paid",
          gross: row.gross,
          net_v: row.gross - row.discounts - row.refunds,
          naf: row.gross - row.discounts - row.refunds - row.fees,
          transactions: row.transactions,
        });
      }
    }
  }
  return out;
}

function storeRecords(start: string, end: string): Rec[] {
  return demoLines(start, end).map(({ source, businessLine, date, line }) => ({
    source,
    business_line: businessLine,
    location: demoLineKey(line, "location", source),
    channel: demoLineKey(line, "channel", source),
    category: demoLineKey(line, "category", source),
    item: demoLineKey(line, "item", source),
    variant: demoLineKey(line, "variant", source),
    year: date.slice(0, 4),
    month: date.slice(0, 7),
    weekday: weekday(date),
    date,
    gross: line.gross,
    discounts: line.discounts,
    quantity: line.quantity,
    order: line.orderKey,
  }));
}

function dataset(spec: ReportSpec, pf: ProgramFamilySettings, schools: SchoolMap, usesWeek: boolean): { recs: Rec[]; measures: Record<string, Measure> } {
  switch (spec.dataset) {
    case "enrollments":
      return {
        recs: enrollmentRecords(pf, schools, usesWeek),
        measures: {
          enrollments: (rs) => rs.filter(EN).length,
          campers: (rs) => distinct(rs, "camper_id", EN),
          families: (rs) => distinct(rs, "camper_id", EN),
          registrations: (rs) => rs.length,
          cancelled: (rs) => rs.filter((r) => r.status_code === "CN").length,
          withdrawn: (rs) => rs.filter((r) => r.status_code === "WD").length,
          waitlisted: (rs) => rs.filter((r) => r.status_code === "WL").length,
        },
      };
    case "camper_seasons":
      return {
        recs: camperSeasonRecords(pf, schools),
        measures: {
          campers: (rs) => distinct(rs, "camper_id"),
          avg_sessions: (rs) => avg(rs, "sessions_n"),
          avg_weeks: (rs) => avg(rs, "weeks_n"),
          return_rate: (rs) => avg(rs.filter((r) => r.returned_flag !== null).map((r) => ({ x: r.returned_flag ? 1 : 0 })), "x"),
          sessions_total: (rs) => sum(rs, "sessions_n"),
          families: (rs) => distinct(rs, "camper_id"),
          return_rate_same_group: (rs) =>
            avg(rs.filter((r) => r.returned_same_group !== null).map((r) => ({ x: r.returned_same_group ? 1 : 0 })), "x"),
          avg_sessions_matching: (rs) => avg(rs, "matching_sessions"),
          sessions_matching: (rs) => sum(rs, "matching_sessions"),
          cancel_rate: (rs) => avg(rs.map((r) => ({ x: Number(r.cancelled_sessions) > 0 ? 1 : 0 })), "x"),
          cancelled_sessions: (rs) => sum(rs, "cancelled_sessions"),
        },
      };
    case "program_families":
      return {
        recs: familyRecords(pf, schools),
        measures: { campers: (rs) => distinct(rs, "camper_id"), avg_branches: (rs) => avg(rs, "branches_n") },
      };
    case "revenue":
      return {
        recs: revenueRecords(spec.start!, spec.end!),
        measures: {
          net: (rs) => sum(rs, "net_v"),
          gross: (rs) => sum(rs, "gross"),
          net_after_fees: (rs) => sum(rs, "naf"),
          transactions: (rs) => sum(rs, "transactions"),
        },
      };
    case "store_sales":
      return {
        recs: storeRecords(spec.start!, spec.end!),
        measures: {
          net: (rs) => rs.reduce((t, r) => t + Number(r.gross) - Number(r.discounts), 0),
          gross: (rs) => sum(rs, "gross"),
          discounts: (rs) => sum(rs, "discounts"),
          units: (rs) => sum(rs, "quantity"),
          orders: (rs) => distinct(rs, "order"),
        },
      };
  }
}

/** Same as the SQL's campersComputed: sessions in the chosen groups, and whether the camper came back to the same group. */
function campersComputed(r: Rec, exploded: string[], filters: Record<string, string[]>) {
  const fields = ["session_group", "session", "program", "program_family", "week"];
  const inSession = (x: Rec, id: string, values: string[]) =>
    id === "week" ? (x.weeks as string[]).some((w) => values.includes(w)) : values.includes((x[id] as string | null) ?? NONE_VALUE);
  const sessions = (r.session_list as Rec[]).filter((x) =>
    fields.every((id) => (exploded.includes(id) ? inSession(x, id, [String(r[id])]) : filters[id] ? inSession(x, id, filters[id]) : true)),
  );
  const back = r.returned_groups as string[] | null;
  const same =
    back === null
      ? null
      : exploded.includes("session_group")
        ? back.includes(String(r.session_group))
        : filters.session_group
          ? back.some((g) => filters.session_group!.includes(g))
          : back.length > 0;
  return { matching_sessions: sessions.length, returned_same_group: same };
}

export function demoRunReport(spec: ReportSpec, pf: ProgramFamilySettings, schools: SchoolMap = new Map()): ReportResult {
  const filters = effectiveFilters(spec);
  const exclude = Object.fromEntries(Object.entries(spec.exclude).filter(([, v]) => v.length > 0));
  const usesWeek = spec.rows.includes("week") || spec.column === "week" || "week" in filters || "week" in exclude;
  const { recs: all, measures } = dataset(spec, pf, schools, usesWeek);
  // Same rules as the SQL: a multi-valued row or column splits each record by value; a multi-valued filter keeps it once.
  const multi = MULTI[spec.dataset] ?? {};
  const list = (r: Rec, id: string) => {
    const vs = (r[multi[id]!] as string[] | undefined) ?? [];
    return vs.length ? vs : [null];
  };
  const exploded = [...spec.rows, ...(spec.column ? [spec.column] : [])].filter((id) => id in multi);
  const recs = exploded.reduce<Rec[]>((rs, id) => rs.flatMap((r) => list(r, id).map((v) => ({ ...r, [id]: v }))), all);
  const val = (r: Rec, id: string) => str(r[id]) ?? NONE_VALUE;
  const matches = (r: Rec, id: string, values: string[]) =>
    id in multi && !exploded.includes(id) ? list(r, id).some((v) => values.includes(v ?? NONE_VALUE)) : values.includes(val(r, id));
  const excluded = (r: Rec, id: string, values: string[]) =>
    id in multi ? list(r, id).some((v) => values.includes(v ?? NONE_VALUE)) : values.includes(val(r, id));
  const picked = recs
    .filter((r) => Object.entries(filters).every(([id, values]) => matches(r, id, values)))
    .filter((r) => Object.entries(exclude).every(([id, values]) => !excluded(r, id, values)))
    .map((r) => (spec.dataset === "camper_seasons" ? { ...r, ...campersComputed(r, exploded, filters) } : r));
  const measure = measures[spec.measure]!;
  const rowIds = spec.rows;
  const sets: Array<{ rows: boolean; col: boolean }> = [];
  const hasRows = rowIds.length > 0;
  const hasCol = !!spec.column;
  sets.push({ rows: hasRows, col: hasCol });
  if (hasRows && hasCol) sets.push({ rows: true, col: false }, { rows: false, col: true });
  if (hasRows || hasCol) sets.push({ rows: false, col: false });
  const out: Array<Record<string, unknown>> = [];
  for (const set of sets) {
    const groups = new Map<string, { key: Record<string, unknown>; rs: Rec[] }>();
    for (const r of picked) {
      const key: Record<string, unknown> = {};
      if (set.rows) rowIds.forEach((id, i) => (key[`r${i}`] = val(r, id)));
      if (set.col) key.c = val(r, spec.column!);
      const k = JSON.stringify(key);
      const g = groups.get(k) ?? { key, rs: [] };
      g.rs.push(r);
      groups.set(k, g);
    }
    if (groups.size === 0 && !set.rows && !set.col) groups.set("{}", { key: {}, rs: [] });
    for (const g of groups.values()) {
      out.push({ ...g.key, value: measure(g.rs), g_row: hasRows && !set.rows ? 1 : 0, g_col: hasCol && !set.col ? 1 : 0 });
    }
  }
  out.sort((a, b) => Number(b.g_row) + Number(b.g_col) - (Number(a.g_row) + Number(a.g_col)) || Number(b.value ?? 0) - Number(a.value ?? 0));
  return toReportResult(spec, out);
}
