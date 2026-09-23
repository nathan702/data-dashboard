import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { autoGranularity } from "./filters";
import { formatPercent, percentChange, timeAgo } from "./format";
import { health } from "../components/Freshness";

describe("csv export", () => {
  it("quotes and neutralizes spreadsheet formulas", () => {
    const csv = toCsv([{ a: '=HYPERLINK("x")', b: 'He said "hi", ok', c: -5 }], [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ]);
    expect(csv).toBe('A,B,C\r\n"\'=HYPERLINK(""x"")","He said ""hi"", ok",-5');
  });
});

describe("formatting", () => {
  it("handles percent change edge cases", () => {
    expect(percentChange(110, 100)).toBeCloseTo(0.1);
    expect(percentChange(5, 0)).toBeNull();
    expect(formatPercent(null)).toBe("–");
    expect(formatPercent(-0.0734)).toBe("−7.3%");
  });
  it("describes elapsed time", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(timeAgo("2026-09-23T11:59:30Z", now)).toBe("30s ago");
    expect(timeAgo("2026-09-23T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo(null, now)).toBe("never");
  });
  it("picks chart buckets by range length", () => {
    expect(autoGranularity("2026-09-01", "2026-09-30")).toBe("day");
    expect(autoGranularity("2026-01-01", "2026-09-30")).toBe("week");
    expect(autoGranularity("2020-01-01", "2026-09-30")).toBe("month");
  });
});

describe("source health", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const base = { source: "shopify" as const, lastError: null };
  it("flags errors, staleness and never-connected sources", () => {
    expect(health({ ...base, status: "ok", lastDataAt: "2026-09-23T11:59:00Z", lastSuccessAt: "2026-09-23T11:50:00Z" }, now)).toBe("good");
    expect(health({ ...base, status: "ok", lastDataAt: null, lastSuccessAt: "2026-09-23T10:00:00Z" }, now)).toBe("warning");
    expect(health({ ...base, status: "error", lastDataAt: null, lastSuccessAt: null }, now)).toBe("critical");
    expect(health({ ...base, status: "never_run", lastDataAt: null, lastSuccessAt: null }, now)).toBe("pending");
  });
});
