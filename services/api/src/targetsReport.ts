import { TARGET_MEASURE_INFO, TARGET_STATUS_LABEL, type ReportResult, type ReportSpec, type TargetProgressResponse } from "@dash/shared";
import { pivotRecords, type Measure, type Rec } from "./warehouse/reportPivot.js";

const sum = (rs: Rec[], k: string) => rs.reduce((t, r) => t + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
const ratio = (num: string, den: string, onlyWith = den): Measure => (rs) => {
  const with_ = rs.filter((r) => typeof r[onlyWith] === "number");
  const d = sum(with_, den);
  return d > 0 ? sum(with_, num) / d : null;
};

const MEASURES: Record<string, Measure> = {
  target: (rs) => sum(rs, "target"),
  now: (rs) => sum(rs, "now"),
  expected: (rs) => (rs.some((r) => typeof r.expected === "number") ? sum(rs, "expected") : null),
  of_target: ratio("now", "target"),
  of_expected: ratio("now", "expected"),
  targets: (rs) => rs.length,
};

/** One record per target, from each line and season's progress. */
export function targetRecords(progress: TargetProgressResponse[], today: string): Rec[] {
  return progress.flatMap((p) =>
    p.season === null || !p.range
      ? []
      : p.rows.map((r) => ({
          season: String(p.season),
          business_line: p.businessLine,
          measure: TARGET_MEASURE_INFO[r.measure].label + (TARGET_MEASURE_INFO[r.measure].money ? " ($)" : ""),
          status: TARGET_STATUS_LABEL[r.status],
          season_state: p.ended ? "Finished" : today < p.range!.start ? "Not started" : "Under way",
          target: r.target,
          now: r.actual,
          expected: r.expected,
        })),
  );
}

export function runTargetsReport(spec: ReportSpec, progress: TargetProgressResponse[], today: string): ReportResult {
  return pivotRecords(spec, targetRecords(progress, today), MEASURES);
}
