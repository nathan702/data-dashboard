import { describe, expect, it } from "vitest";
import {
  cleanTargetSettings,
  defaultTargetSeason,
  emptyTargetActuals,
  expectedByNow,
  lineTargetMeasures,
  registrationOpened,
  samePointLastSeason,
  targetProgressRows,
  targetSeasons,
  targetStatus,
} from "./targets.js";
import { DEFAULT_REGISTRATION } from "./seasons.js";

describe("targets", () => {
  it("offers revenue plus what each line's platforms count", () => {
    expect(lineTargetMeasures("camp")).toEqual(["revenue", "campers", "enrollments"]);
    expect(lineTargetMeasures("chaps")).toEqual(["revenue", "campers", "enrollments", "participants"]);
    expect(lineTargetMeasures("haunted_forest")).toEqual(["revenue", "guests"]);
    expect(lineTargetMeasures("farm_store")).toEqual(["revenue"]);
  });

  it("keeps only known lines and the measures they can have", () => {
    const s = cleanTargetSettings({
      seasons: {
        "2027": { camp: { revenue: 1_000_000, guests: 5 }, nowhere: { revenue: 1 }, farm_store: {} },
        "2026": { farm_store: { campers: 3 } },
      },
    });
    expect(s).toEqual({ seasons: { "2027": { camp: { revenue: 1_000_000 } } } });
    expect(cleanTargetSettings({ seasons: { "2027": { camp: { revenue: -5 } } } })).toEqual({ seasons: {} });
    expect(cleanTargetSettings(null)).toEqual({ seasons: {} });
  });

  it("opens on the season under way, else the next, else the newest", () => {
    const s = cleanTargetSettings({ seasons: { "2025": { camp: { revenue: 1 } }, "2027": { camp: { revenue: 2 } }, "2026": { events: { revenue: 3 } } } });
    expect(targetSeasons(s, "camp")).toEqual([2027, 2025]);
    expect(defaultTargetSeason([2027, 2025], 2027)).toBe(2027);
    expect(defaultTargetSeason([2027, 2025], 2026)).toBe(2027);
    expect(defaultTargetSeason([2025], 2026)).toBe(2025);
    expect(defaultTargetSeason([], 2026)).toBeNull();
  });

  it("expects last season's share of its final total by the same point", () => {
    expect(expectedByNow(1000, 40, 100)).toBe(400);
    expect(expectedByNow(1000, 150, 100)).toBe(1000);
    expect(expectedByNow(1000, 0, 0)).toBeNull();
  });

  it("calls within 5% of expected on track", () => {
    const s = (actual: number, expected: number | null, ended = false) => targetStatus({ target: 1000, actual, expected, ended });
    expect(s(400, 400)).toBe("on_track");
    expect(s(419, 400)).toBe("on_track");
    expect(s(421, 400)).toBe("ahead");
    expect(s(379, 400)).toBe("behind");
    expect(s(10, 0)).toBe("ahead");
    expect(s(0, 0)).toBe("on_track");
    expect(s(10, null)).toBe("no_pace");
    expect(s(1000, 1000, true)).toBe("reached");
    expect(s(999, 1000, true)).toBe("missed");
  });

  it("lines Camp up by days since registration opened, events by weekday, the rest by date", () => {
    expect(registrationOpened(DEFAULT_REGISTRATION, 2026)).toBe("2026-01-06");
    expect(registrationOpened(DEFAULT_REGISTRATION, 2030)).toBeNull();
    // 2026 opened Jan 6; 2025 opened Jan 14. Ten days in → Jan 24, 2025.
    expect(samePointLastSeason("camp", 2026, "2026-01-16", DEFAULT_REGISTRATION)).toEqual({ cutoff: "2025-01-24", alignedBy: "registration" });
    // Before registration opens, the offset is negative.
    expect(samePointLastSeason("camp", 2026, "2025-12-27", DEFAULT_REGISTRATION).cutoff).toBe("2025-01-04");
    expect(samePointLastSeason("camp", 2030, "2030-02-01", DEFAULT_REGISTRATION)).toEqual({ cutoff: "2029-02-01", alignedBy: "date" });
    expect(samePointLastSeason("events", 2026, "2026-06-06", DEFAULT_REGISTRATION)).toEqual({ cutoff: "2025-06-07", alignedBy: "weekday" });
    expect(samePointLastSeason("farm_store", 2026, "2026-06-06", DEFAULT_REGISTRATION)).toEqual({ cutoff: "2025-06-06", alignedBy: "date" });
  });

  it("builds a row per target in the line's measure order", () => {
    const a = emptyTargetActuals();
    a.revenue = { current: 500, previousAtSamePoint: 50, previousFinal: 100 };
    a.campers = { current: 90, previousAtSamePoint: 0, previousFinal: 0 };
    const rows = targetProgressRows("camp", { campers: 200, revenue: 1000 }, a, false);
    expect(rows.map((r) => [r.measure, r.expected, r.status])).toEqual([
      ["revenue", 500, "on_track"],
      ["campers", null, "no_pace"],
    ]);
    expect(targetProgressRows("camp", { revenue: 1000 }, a, true)[0]).toMatchObject({ expected: 1000, status: "missed" });
  });
});
