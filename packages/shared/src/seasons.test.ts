import { describe, expect, it } from "vitest";
import {
  CALENDAR_YEAR,
  campminderCalendar,
  cleanSeasonSettings,
  DEFAULT_SEASON_SETTINGS,
  endDateCalendar,
  laborDay,
  lineCalendar,
  seasonNameFromStart,
  seasonStarts,
} from "./seasons.js";

describe("seasons", () => {
  it("finds Labor Day", () => {
    expect(laborDay(2025)).toBe("2025-09-01");
    expect(laborDay(2026)).toBe("2026-09-07");
    expect(laborDay(2027)).toBe("2027-09-06");
  });

  it("Campminder seasons run from Labor Day to the Sunday before the next one", () => {
    const cm = campminderCalendar();
    expect(cm.range(2026)).toEqual({ start: "2025-09-01", end: "2026-09-06" });
    expect(cm.seasonFor("2026-08-28")).toBe(2026); // Friday before Labor Day: last week of camp
    expect(cm.seasonFor("2026-09-07")).toBe(2027); // Labor Day starts the next season
    expect(cm.seasonFor("2026-01-15")).toBe(2026);
  });

  it("lets a year's Campminder season start on another day", () => {
    const cm = campminderCalendar({ "2027": "2026-08-31" });
    expect(cm.range(2026).end).toBe("2026-08-30");
    expect(cm.seasonFor("2026-08-31")).toBe(2027);
  });

  it("calendar-year seasons", () => {
    expect(CALENDAR_YEAR.range(2026)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(CALENDAR_YEAR.seasonFor("2026-12-31")).toBe(2026);
  });

  it("seasons ending on a set date, reusing the nearest year's date when unset", () => {
    const hf = endDateCalendar({ "2026": "2026-11-08" });
    expect(hf.seasonFor("2026-11-08")).toBe(2026);
    expect(hf.seasonFor("2026-11-09")).toBe(2027); // off-season counts toward next year's run
    expect(hf.range(2027)).toEqual({ start: "2026-11-09", end: "2027-11-08" });
    expect(endDateCalendar().lastDay(2026)).toBe("2026-11-01");
  });

  it("uses each line's rule, with defaults from the plan", () => {
    expect(lineCalendar("camp").rule).toBe("calendar");
    expect(lineCalendar("school_year").rule).toBe("campminder");
    expect(lineCalendar("haunted_forest").range(2026).end).toBe("2026-11-08");
    const s = cleanSeasonSettings({ rules: { camp: "end_dates" }, endDates: { camp: { "2026": "2026-08-28" } } });
    expect(lineCalendar("camp", s).range(2026).end).toBe("2026-08-28");
    expect(s.rules.river_school).toBe("calendar");
    expect(cleanSeasonSettings({ rules: { camp: "nope" } })).toEqual(DEFAULT_SEASON_SETTINGS);
  });

  it("buckets and names seasons", () => {
    expect(seasonStarts(campminderCalendar(), "2025-06-01", "2026-10-01")).toEqual(["2024-09-02", "2025-09-01", "2026-09-07"]);
    expect(seasonNameFromStart("2025-09-01")).toBe(2026);
    expect(seasonNameFromStart("2026-01-01")).toBe(2026);
    expect(seasonNameFromStart("2026-11-09")).toBe(2027);
  });
});
