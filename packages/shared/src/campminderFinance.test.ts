import { describe, expect, it } from "vitest";
import { isCampExtra, summarizeCampminderExtras, yearBefore } from "./campminderFinance.js";

describe("camp extras", () => {
  it("adds up items this season and last, keeping this season's weeks and sessions", () => {
    const x = summarizeCampminderExtras(
      [
        { season: 2026, item: "Week N Lunch", week: 3, sessionGroup: "Farm", count: 4, revenue: 180 },
        { season: 2026, item: "Week N Lunch", week: 4, sessionGroup: "Farm", count: 2, revenue: 90 },
        { season: 2026, item: "Gear Bag", week: null, sessionGroup: "Riley's", count: 1, revenue: 35 },
        { season: 2025, item: "Week N Lunch", week: 3, sessionGroup: "Farm", count: 3, revenue: 120 },
        { season: 2025, item: "Backpack", week: null, sessionGroup: "Farm", count: 1, revenue: 28 },
        { season: 2024, item: "Backpack", week: null, sessionGroup: "Farm", count: 9, revenue: 900 },
      ],
      { season: 2026, businessLine: "camp" },
      "2025-11-18",
    );
    expect(x.items).toEqual([
      { item: "Week N Lunch", count: 6, revenue: 270, lastCount: 3, lastRevenue: 120 },
      { item: "Gear Bag", count: 1, revenue: 35, lastCount: 0, lastRevenue: 0 },
      { item: "Backpack", count: 0, revenue: 0, lastCount: 1, lastRevenue: 28 },
    ]);
    expect(x.bySession.map((r) => [r.item, r.week])).toEqual([["Gear Bag", null], ["Week N Lunch", 3], ["Week N Lunch", 4]]);
    expect(x.lastSeasonCutoff).toBe("2025-11-18");
  });

  it("counts lunches and gear in any category, and anything Miscellaneous, but not tuition", () => {
    expect(isCampExtra("Summer Camp", "Week 3 Lunch")).toBe(true);
    expect(isCampExtra("Summer Camp", "Gear Bag")).toBe(true);
    expect(isCampExtra("Summer Camp", "Explorer Backpack (with Shipping)")).toBe(true);
    expect(isCampExtra("Miscellaneous", "Cancellation Fee")).toBe(true);
    expect(isCampExtra("Summer Camp", "Farm Week 3")).toBe(false);
    expect(isCampExtra("Summer Camp", "Lunchbox Explorers Week 2")).toBe(false);
    expect(isCampExtra("Miscellaneous", null)).toBe(false);
  });

  it("finds the same date a year back", () => {
    expect(yearBefore("2026-11-18")).toBe("2025-11-18");
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
  });
});
