import { describe, expect, it } from "vitest";
import { leadBucket, ticketTypeFor, type FareharborDayRow, type FareharborDaysResponse } from "./fareharbor.js";
import { perGuest, summarizeFareharbor } from "./fareharborSummary.js";

const row = (day: string, item: string, guests: number, revenue: number, sp = 1, lead: FareharborDayRow["lead"] = "4-6"): FareharborDayRow => ({
  day,
  item,
  lead,
  revenue,
  guests,
  bookings: 1,
  revenueAtSamePoint: revenue * sp,
  guestsAtSamePoint: Math.round(guests * sp),
});

const base = (rows: FareharborDayRow[], closures: string[] = []): FareharborDaysResponse => ({
  businessLine: "haunted_forest",
  season: 2026,
  seasons: [2026, 2025],
  nightly: true,
  current: { start: "2025-11-09", end: "2026-11-08" },
  previous: { start: "2024-11-11", end: "2025-11-08" },
  asOf: "2026-10-12",
  samePointCutoff: "2025-10-12",
  rows,
  closures: closures.map((date) => ({ businessLine: "haunted_forest", date, note: "Weather" })),
  itemTypes: {},
});

describe("ticket types", () => {
  it("reads the type from the item name; Settings win", () => {
    expect(ticketTypeFor("Combo: Trail + Town")).toBe("combo");
    expect(ticketTypeFor("Haunted Trail")).toBe("trail");
    expect(ticketTypeFor("Haunted Town")).toBe("town");
    expect(ticketTypeFor("Upside Down Express Access Pass")).toBe("package");
    expect(ticketTypeFor("Gift card")).toBe("other");
    expect(ticketTypeFor("Gift card", { "Gift card": "trail" })).toBe("trail");
  });
  it("buckets lead days", () => {
    expect([0, 1, 2, 5, 7, 14, 30, 60].map(leadBucket)).toEqual(["0", "1", "2-3", "4-6", "7-13", "14-20", "28-41", "56+"]);
  });
});

describe("summarizeFareharbor", () => {
  it("matches nights by the closest weekday and splits held, upcoming and unmatched", () => {
    const s = summarizeFareharbor(
      base([
        // Fri 10/2/2026 ↔ Fri 10/3/2025
        row("2026-10-02", "Haunted Trail", 100, 4500),
        row("2025-10-03", "Haunted Trail", 120, 5000, 0.5),
        // Sat 10/3/2026 has no 2025 match
        row("2026-10-03", "Combo", 50, 3500),
        // Fri 10/16/2026 is upcoming; its match Fri 10/17/2025 sold 40% by the same point
        row("2026-10-16", "Haunted Town", 30, 1200),
        row("2025-10-17", "Haunted Town", 80, 3200, 0.4),
      ]),
    );
    expect(s.held.current).toMatchObject({ days: 2, current: { revenue: 8000, guests: 150 } });
    expect(s.held.matching.days).toBe(1);
    expect(s.held.matching.previous.revenue).toBe(5000);
    expect(s.held.matching.previousAtSamePoint.revenue).toBe(2500);
    expect(s.held.unmatched).toMatchObject({ days: 1, current: { revenue: 3500 } });
    expect(s.upcoming.current.current.revenue).toBe(1200);
    expect(s.upcoming.previousAtSamePoint.current).toMatchObject({ revenue: 1280, guests: 32 });
    expect(s.days.map((d) => d.label)).toEqual(["1st Fri", "1st Sat", "3rd Fri"]);
    expect(s.held.current.current.byGroup.trail).toEqual({ revenue: 4500, guests: 100 });
    expect(perGuest(s.held.current.current)).toBe(53.33);
  });

  it("leaves out closed nights and their match last year, but keeps a night whose match was closed", () => {
    const s = summarizeFareharbor(
      base(
        [
          row("2026-10-11", "Haunted Trail", 10, 400),
          row("2025-10-12", "Haunted Trail", 90, 4000),
          row("2026-10-04", "Haunted Trail", 70, 3000),
          row("2025-10-05", "Haunted Trail", 60, 2500),
        ],
        ["2026-10-11", "2025-10-05"],
      ),
    );
    expect(s.held.current.current.revenue).toBe(3000);
    expect(s.held.previous.current.revenue).toBe(0);
    expect(s.held.matching.days).toBe(0);
    expect(s.days.find((d) => d.aligned === "2026-10-11")).toMatchObject({ current: null, previous: null });
  });

  it("counts lead time for Town, Trail and Combo only on nightly lines", () => {
    const s = summarizeFareharbor(base([row("2026-10-02", "Haunted Trail", 10, 400, 1, "0"), row("2026-10-02", "Upside Down Dinner", 5, 900, 1, "0")]));
    expect(s.lead.current[0]).toBe(10);
    expect(s.lead.byWeekend.current[0]).toMatchObject({ label: "1st Wknd", guests: 10 });
  });
});

import { hubspotSettingsSchema, resolveHubspotRoles } from "./hubspot.js";

describe("hubspot roles", () => {
  const props = [
    { name: "free_chaperones", label: "Free chaperone count", type: "number", options: [] },
    { name: "paid_chaperones", label: "Paid chaperone count", type: "number", options: [] },
    { name: "students", label: "Number of students", type: "number", options: [] },
    { name: "students_est", label: "Estimated students", type: "number", options: [] },
    { name: "program_type", label: "Program Type", type: "enumeration", options: [] },
  ];
  it("adds up every chaperone count automatically, but guesses one participant count", () => {
    const r = resolveHubspotRoles({ participants: [], chaperones: [], programType: [], food: [], transportation: [] }, props);
    expect(r.chaperones).toEqual(["free_chaperones", "paid_chaperones"]);
    expect(r.participants).toEqual(["students"]);
    expect(r.programType).toEqual(["program_type"]);
    expect(r.food).toEqual([]);
  });
  it("uses the properties set on Settings, and reads older single-name settings", () => {
    const settings = hubspotSettingsSchema.parse({ participants: "students_est", chaperones: ["paid_chaperones"], programType: null, food: null, transportation: null });
    expect(settings.participants).toEqual(["students_est"]);
    const r = resolveHubspotRoles(settings, props);
    expect(r.participants).toEqual(["students_est"]);
    expect(r.chaperones).toEqual(["paid_chaperones"]);
  });
});
