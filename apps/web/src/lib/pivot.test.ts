import { describe, expect, it } from "vitest";
import { REPORT_DATASET_INFO, reportSpecSchema, type ReportCell } from "@dash/shared";
import { buildPivot, formatMeasure } from "./pivot";

const spec = reportSpecSchema.parse({ dataset: "enrollments", rows: ["grade"], column: "season", measure: "campers", percent: "column" });
const cells: ReportCell[] = [
  { kind: "cell", rows: ["2nd"], column: "2026", value: 30 },
  { kind: "cell", rows: ["K"], column: "2026", value: 10 },
  { kind: "cell", rows: ["10th"], column: "2025", value: 5 },
  { kind: "row_total", rows: ["2nd"], column: null, value: 30 },
  { kind: "row_total", rows: ["K"], column: null, value: 10 },
  { kind: "row_total", rows: ["10th"], column: null, value: 5 },
  { kind: "column_total", rows: [], column: "2026", value: 38 },
  { kind: "column_total", rows: [], column: "2025", value: 5 },
  { kind: "total", rows: [], column: null, value: 42 },
];

describe("pivot", () => {
  it("sorts by each field's natural order and uses database totals", () => {
    const p = buildPivot({ spec, cells, truncated: false, generatedAt: "" }, REPORT_DATASET_INFO.enrollments);
    expect(p.rowKeys).toEqual([["K"], ["2nd"], ["10th"]]);
    expect(p.colKeys).toEqual(["2025", "2026"]);
    // Distinct campers: the total (42) isn't the sum of the cells (45).
    expect(p.total).toBe(42);
    expect(p.shown(10, ["K"], "2026")).toBeCloseTo(10 / 38);
    expect(formatMeasure(p.shown(10, ["K"], "2026"), "share")).toBe("26.3%");
  });

  it("sorts text fields biggest first, with (none) last", () => {
    const s = reportSpecSchema.parse({ dataset: "enrollments", rows: ["program"], measure: "enrollments" });
    const p = buildPivot(
      {
        spec: s,
        cells: [
          { kind: "cell", rows: ["(none)"], column: null, value: 99 },
          { kind: "cell", rows: ["Quest"], column: null, value: 5 },
          { kind: "cell", rows: ["Cubs"], column: null, value: 50 },
          { kind: "total", rows: [], column: null, value: 154 },
        ],
        truncated: false,
        generatedAt: "",
      },
      REPORT_DATASET_INFO.enrollments,
    );
    expect(p.rowKeys.map((r) => r[0])).toEqual(["Cubs", "Quest", "(none)"]);
  });
});
