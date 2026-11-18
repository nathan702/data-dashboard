import { describe, expect, it } from "vitest";
import { resolveCampExtras, summarizeCampminderExtras, yearBefore } from "./campminderFinance.js";

describe("camp extras", () => {
  it("adds up items this season and last, keeping this season's weeks and sessions", () => {
    const x = summarizeCampminderExtras(
      [
        { season: 2026, item: "Lunch", week: 3, sessionGroup: "Farm", count: 4, revenue: 180 },
        { season: 2026, item: "Lunch", week: 4, sessionGroup: "Farm", count: 2, revenue: 90 },
        { season: 2026, item: "Gear Bag", week: null, sessionGroup: "Riley's", count: 1, revenue: 35 },
        { season: 2025, item: "Lunch", week: 3, sessionGroup: "Farm", count: 3, revenue: 120 },
        { season: 2025, item: "Backpack", week: null, sessionGroup: "Farm", count: 1, revenue: 28 },
        { season: 2024, item: "Backpack", week: null, sessionGroup: "Farm", count: 9, revenue: 900 },
      ],
      { season: 2026, businessLine: "camp" },
      "2025-11-18",
    );
    expect(x.items).toEqual([
      { item: "Lunch", count: 6, revenue: 270, lastCount: 3, lastRevenue: 120 },
      { item: "Gear Bag", count: 1, revenue: 35, lastCount: 0, lastRevenue: 0 },
      { item: "Backpack", count: 0, revenue: 0, lastCount: 1, lastRevenue: 28 },
    ]);
    expect(x.bySession.map((r) => [r.item, r.week])).toEqual([["Gear Bag", null], ["Lunch", 3], ["Lunch", 4]]);
    expect(x.lastSeasonCutoff).toBe("2025-11-18");
  });

  it("uses the chosen Summer Camp items, else lunches, gear and cancellation fees", () => {
    const items = ["Cubs/Explorers", "Lunch", "Gear Bag", "Explorer Backpack (with Shipping)", "Summer Camp Cancellation Fee", "Fuel Charge", "Lunchbox Explorers"];
    expect(resolveCampExtras(null, items)).toEqual(["Lunch", "Gear Bag", "Explorer Backpack (with Shipping)", "Summer Camp Cancellation Fee"]);
    expect(resolveCampExtras(["Fuel Charge"], items)).toEqual(["Fuel Charge"]);
    expect(resolveCampExtras([], items)).toEqual([]);
  });

  it("finds the same date a year back", () => {
    expect(yearBefore("2026-11-18")).toBe("2025-11-18");
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
  });
});
