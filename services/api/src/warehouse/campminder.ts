import {
  addYears,
  easternDate,
  gradeOrder,
  seasonRange,
  type EnrollmentBreakdownRow,
  type EnrollmentDimension,
  type EnrollmentKpis,
} from "@dash/shared";

/** Shared by the BigQuery and demo warehouses so both shape results the same way. */
export function enrollmentAsOf(season: number, today = easternDate()) {
  const end = seasonRange(season).end;
  const asOf = today < end ? today : end;
  return { asOf, prevCutoff: addYears(asOf, -1), seasonStart: seasonRange(season).start };
}

export function toEnrollmentKpis(r: Partial<Record<string, unknown>> | undefined): EnrollmentKpis {
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    campers: n("campers"),
    enrollments: n("enrollments"),
    newCampers: n("new_campers"),
    returningCampers: n("returning_campers"),
    cancelled: n("cancelled"),
    withdrawn: n("withdrawn"),
    waitlisted: n("waitlisted"),
  };
}

/** Cumulative weekly totals for this season (up to today) and last season. */
export function buildPace(
  rows: Array<{ season: number; week_of_season: number; enrollments: number }>,
  season: number,
  asOf: string,
  seasonStart: string,
) {
  const weeksSoFar = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${seasonStart}T00:00:00Z`)) / (7 * 86_400_000));
  const perWeek = (s: number) => {
    const m = new Map<number, number>();
    for (const r of rows) if (Number(r.season) === s) m.set(Number(r.week_of_season), (m.get(Number(r.week_of_season)) ?? 0) + Number(r.enrollments));
    return m;
  };
  const cur = perWeek(season);
  const prev = perWeek(season - 1);
  const hasPrev = prev.size > 0;
  let c = 0;
  let p = 0;
  const out: Array<{ weekOfSeason: number; current: number | null; previous: number | null }> = [];
  for (let w = 0; w <= 52; w++) {
    c += cur.get(w) ?? 0;
    p += prev.get(w) ?? 0;
    out.push({ weekOfSeason: w, current: w <= weeksSoFar ? c : null, previous: hasPrev ? p : null });
  }
  return out;
}

const NUMERIC: EnrollmentDimension[] = ["week", "age", "years"];

export function sortBreakdown(rows: EnrollmentBreakdownRow[], dimension: EnrollmentDimension) {
  const sorted = [...rows];
  if (NUMERIC.includes(dimension)) sorted.sort((a, b) => (Number(a.key) || 999) - (Number(b.key) || 999));
  else if (dimension === "grade") sorted.sort((a, b) => gradeOrder(a.key) - gradeOrder(b.key));
  else sorted.sort((a, b) => b.enrollments - a.enrollments || a.key.localeCompare(b.key));
  return sorted;
}
