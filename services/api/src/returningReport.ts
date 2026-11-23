import {
  RETURNING_STATUS_LABEL,
  RETURNING_WAVE_LABEL,
  returningSegmentKey,
  weeksAfterOpening,
  type ReportResult,
  type ReportSpec,
  type ReturningFamily,
} from "@dash/shared";
import { pivotRecords, type Measure, type Rec } from "./warehouse/reportPivot.js";

const kept = (rs: Rec[]) => rs.filter((r) => r.status !== RETURNING_STATUS_LABEL.aged_out);
const count = (status: keyof typeof RETURNING_STATUS_LABEL, onlyKept = false): Measure => (rs) =>
  (onlyKept ? kept(rs) : rs).filter((r) => r.status === RETURNING_STATUS_LABEL[status]).length;
const sum = (rs: Rec[], k: string) => rs.reduce((t, r) => t + Number(r[k] ?? 0), 0);

const MEASURES: Record<string, Measure> = {
  families: (rs) => rs.length,
  reenrolled: count("enrolled"),
  not_yet: count("not_yet"),
  waitlisted: count("waitlisted"),
  aged_out: count("aged_out"),
  pct_reenrolled: (rs) => {
    const k = kept(rs);
    return k.length ? count("enrolled")(k)! / k.length : null;
  },
  eligible_campers: (rs) => sum(kept(rs), "eligible_campers"),
  reenrolled_campers: (rs) => sum(kept(rs), "reenrolled_campers"),
  pct_campers_reenrolled: (rs) => {
    const of = sum(kept(rs), "eligible_campers");
    return of > 0 ? sum(kept(rs), "reenrolled_campers") / of : null;
  },
};

/** One record per family and season, with the report's field ids (see REPORT_DATASET_INFO.returning_families). */
export function returningRecords(families: ReturningFamily[]): Rec[] {
  return families.map((f) => {
    const weeks = weeksAfterOpening(f.status === "enrolled" ? f.day : null);
    return {
      season: String(f.season),
      status: RETURNING_STATUS_LABEL[f.status],
      wave: RETURNING_WAVE_LABEL[f.wave],
      session_group: f.sessionGroup,
      summers: returningSegmentKey(f, "summers"),
      campers_last_season: returningSegmentKey(f, "campers"),
      weeks_last_season: returningSegmentKey(f, "weeks"),
      weeks_after_opening: weeks === null ? null : String(weeks),
      state: f.state,
      zip: f.zip,
      household: f.household,
      eligible_campers: f.eligibleCampers,
      reenrolled_campers: f.reenrolledCampers,
    };
  });
}

export function runReturningReport(spec: ReportSpec, families: ReturningFamily[]): ReportResult {
  return pivotRecords(spec, returningRecords(families), MEASURES);
}
