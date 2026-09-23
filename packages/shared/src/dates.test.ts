import { describe, expect, it } from "vitest";
import {
  addYears,
  comparisonRange,
  easternDate,
  isIsoDate,
  presetRange,
  seasonForDate,
  seasonRange,
} from "./dates.js";

describe("seasons", () => {
  it("assigns fall dates to the following year's season", () => {
    expect(seasonForDate("2025-08-31")).toBe(2025);
    expect(seasonForDate("2025-09-01")).toBe(2026);
    expect(seasonForDate("2026-01-15")).toBe(2026);
    expect(seasonForDate("2026-07-04")).toBe(2026);
  });

  it("respects a custom cutover", () => {
    const config = { startMonth: 8, startDay: 20 };
    expect(seasonForDate("2025-08-19", config)).toBe(2025);
    expect(seasonForDate("2025-08-20", config)).toBe(2026);
    expect(seasonRange(2026, config)).toEqual({ start: "2025-08-20", end: "2026-08-19" });
  });

  it("returns an inclusive season range", () => {
    expect(seasonRange(2026)).toEqual({ start: "2025-09-01", end: "2026-08-31" });
  });
});

describe("comparisons", () => {
  it("previous period has the same length and ends the day before", () => {
    expect(comparisonRange({ start: "2026-03-01", end: "2026-03-31" }, "previous_period")).toEqual({
      start: "2026-01-29",
      end: "2026-02-28",
    });
  });

  it("previous year clamps leap days", () => {
    expect(addYears("2024-02-29", -1)).toBe("2023-02-28");
    expect(comparisonRange({ start: "2024-02-01", end: "2024-02-29" }, "previous_year")).toEqual({
      start: "2023-02-01",
      end: "2023-02-28",
    });
  });

  it("none returns null", () => {
    expect(comparisonRange({ start: "2026-01-01", end: "2026-01-02" }, "none")).toBeNull();
  });
});

describe("presets", () => {
  const today = "2026-09-23";
  it("computes season to date", () => {
    expect(presetRange("season_to_date", today)).toEqual({ start: "2026-09-01", end: today });
    expect(presetRange("last_season", today)).toEqual({ start: "2025-09-01", end: "2026-08-31" });
  });
  it("computes rolling windows inclusively", () => {
    expect(presetRange("last_7_days", today)).toEqual({ start: "2026-09-17", end: today });
    expect(presetRange("month_to_date", today)).toEqual({ start: "2026-09-01", end: today });
  });
});

describe("eastern time", () => {
  it("uses the Eastern calendar date, not UTC", () => {
    // 02:30 UTC on Sep 24 is still Sep 23 in New York (EDT, UTC-4).
    expect(easternDate(new Date("2026-09-24T02:30:00Z"))).toBe("2026-09-23");
  });
  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("26-02-28")).toBe(false);
  });
});
