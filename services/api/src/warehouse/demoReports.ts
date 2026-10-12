import {
  addDays,
  draftProgramFamily,
  NONE_VALUE,
  type ProgramFamilySettings,
  type ReportResult,
  type ReportSpec,
} from "@dash/shared";
import { effectiveFilters } from "./reportSql.js";
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

function familyOf(program: string | null, pf: ProgramFamilySettings) {
  if (!program) return { family: null, branch: null };
  return pf.overrides[program] ?? draftProgramFamily(program);
}

function enrollmentRecords(pf: ProgramFamilySettings, explodeWeeks: boolean): Rec[] {
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
    };
    if (explodeWeeks && r.weekStart !== null) for (let w = r.weekStart; w <= r.weekEnd!; w++) out.push({ ...base, week: String(w) });
    else out.push({ ...base, week: null });
  }
  return out;
}

const EN = (r: Rec) => r.status_code === "EN";

function camperGroups(pf: ProgramFamilySettings, byFamily: boolean): Rec[] {
  const groups = new Map<string, Rec[]>();
  for (const r of enrollmentRecords(pf, false)) {
    if (!EN(r) || (byFamily && !r.program_family)) continue;
    const k = [r.season, r.business_line, r.camper_id, byFamily ? r.program_family : ""].join("|");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    const a = rs[0]!;
    return { ...a, years_at_camp: String(Math.max(...rs.map((r) => Number(r.years)))), rs };
  });
}

function camperSeasonRecords(pf: ProgramFamilySettings): Rec[] {
  const recs: Rec[] = camperGroups(pf, false).map((g): Rec => {
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
    };
  });
  const key = (r: Rec, season: number) => `${r.camper_id}|${r.business_line}|${season}`;
  const present = new Set(recs.map((r) => key(r, Number(r.season))));
  const newest = Math.max(...recs.map((r) => Number(r.season)));
  return recs.map((r) => {
    const returned = Number(r.season) >= newest ? null : present.has(key(r, Number(r.season) + 1));
    return { ...r, returned_flag: returned, returned: returned === null ? "Not known yet" : returned ? "Returned" : "Didn't return" };
  });
}

function familyRecords(pf: ProgramFamilySettings): Rec[] {
  return camperGroups(pf, true).map((g) => {
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

function dataset(spec: ReportSpec, pf: ProgramFamilySettings, usesWeek: boolean): { recs: Rec[]; measures: Record<string, Measure> } {
  switch (spec.dataset) {
    case "enrollments":
      return {
        recs: enrollmentRecords(pf, usesWeek),
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
        recs: camperSeasonRecords(pf),
        measures: {
          campers: (rs) => distinct(rs, "camper_id"),
          avg_sessions: (rs) => avg(rs, "sessions_n"),
          avg_weeks: (rs) => avg(rs, "weeks_n"),
          return_rate: (rs) => avg(rs.filter((r) => r.returned_flag !== null).map((r) => ({ x: r.returned_flag ? 1 : 0 })), "x"),
          sessions_total: (rs) => sum(rs, "sessions_n"),
          families: (rs) => distinct(rs, "camper_id"),
        },
      };
    case "program_families":
      return {
        recs: familyRecords(pf),
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

export function demoRunReport(spec: ReportSpec, pf: ProgramFamilySettings): ReportResult {
  const filters = effectiveFilters(spec);
  const usesWeek = spec.rows.includes("week") || spec.column === "week" || "week" in filters;
  const { recs, measures } = dataset(spec, pf, usesWeek);
  const val = (r: Rec, id: string) => str(r[id]) ?? NONE_VALUE;
  const picked = recs.filter((r) => Object.entries(filters).every(([id, values]) => values.includes(val(r, id))));
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
