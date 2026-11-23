import { describe, expect, it } from "vitest";
import {
  ageOutAfter,
  defaultReturningSeason,
  filterReturning,
  resolveReturning,
  returningCurve,
  returningSegmentKey,
  returningSummary,
  type ReturningFamilyFacts,
} from "./returning.js";
import { DEFAULT_REGISTRATION, type RegistrationSettings } from "./seasons.js";

const reg: RegistrationSettings = {
  opens: {
    "2026": { va: "2026-01-06", md: "2026-01-08", new: "2026-01-12" },
    "2027": { va: "2027-01-05", md: "2027-01-07", new: "2027-01-11" },
  },
  locations: { Farm: "md", Madeira: "va" },
  // Small test cohorts: every camper would be "the oldest age" automatically.
  ageOutAfter: 14,
};

const fam = (over: Partial<ReturningFamilyFacts>): ReturningFamilyFacts => ({
  season: 2027,
  household: "h",
  locations: ["md"],
  sessionGroup: "Farm",
  weeks: 3,
  summers: 2,
  state: "MD",
  zip: "20814",
  campers: [{ age: 9, enrolled: false }],
  enrolled: false,
  waitlisted: false,
  cancelled: false,
  enrolledOn: null,
  ...over,
});

describe("returning families", () => {
  it("puts a family in its earliest-opening wave and counts days from that opening", () => {
    const [f] = resolveReturning([fam({ locations: ["md", "va"], enrolled: true, enrolledOn: "2027-01-08", campers: [{ age: 9, enrolled: true }] })], reg);
    expect(f!.wave).toBe("va");
    expect(f!.day).toBe(3);
    expect(f!.status).toBe("enrolled");
    expect(f!.reenrolledCampers).toBe(1);
  });

  it("sorts statuses: enrolled, waitlisted, cancelled, aged out, not yet", () => {
    const r = resolveReturning(
      [
        fam({ household: "a", waitlisted: true, cancelled: true }),
        fam({ household: "b", cancelled: true }),
        fam({ household: "c", campers: [{ age: 13, enrolled: false }] }),
        fam({ household: "d" }),
        // Fill out the ages so 13 is the oldest common age (1% rule).
        ...Array.from({ length: 50 }, (_, i) => fam({ household: `x${i}`, campers: [{ age: 5 + (i % 9), enrolled: false }] })),
      ],
      { ...reg, ageOutAfter: null },
    );
    const by = (h: string) => r.find((f) => f.household === h)!.status;
    expect([by("a"), by("b"), by("c"), by("d")]).toEqual(["waitlisted", "cancelled", "aged_out", "not_yet"]);
  });

  it("ages out by the setting, else the oldest age 1% of last season's campers were", () => {
    const facts = [...Array.from({ length: 199 }, () => fam({ campers: [{ age: 10, enrolled: false }] })), fam({ campers: [{ age: 17, enrolled: false }] })];
    expect(ageOutAfter(facts, null)).toBe(10); // a lone 17-year-old (0.5%) doesn't count
    expect(ageOutAfter(facts, 14)).toBe(14);
    const [f] = resolveReturning([fam({ campers: [{ age: 13, enrolled: false }, { age: 8, enrolled: false }] })], { ...reg, ageOutAfter: 13 });
    expect(f!.eligibleCampers).toBe(1); // the 13-year-old is 14 next summer
    expect(f!.status).toBe("not_yet");
  });

  it("compares with last season at the same number of days since its wave opened", () => {
    const fams = resolveReturning(
      [
        fam({ household: "now", enrolled: true, enrolledOn: "2027-01-07", campers: [{ age: 9, enrolled: true }] }),
        fam({ household: "later" }),
        fam({ season: 2026, household: "early", enrolled: true, enrolledOn: "2026-01-09" }), // MD day 1
        fam({ season: 2026, household: "late", enrolled: true, enrolledOn: "2026-02-20" }),
        fam({ season: 2026, household: "never" }),
      ],
      reg,
    );
    const s = returningSummary(fams, 2027, reg, { today: "2027-01-08", over: false });
    expect(s.current).toMatchObject({ families: 2, enrolled: 1, notYet: 1 });
    expect(s.previous).toEqual({ families: 3, samePoint: 1, final: 2 });
    // Season over: everything counts.
    expect(returningSummary(fams, 2027, reg, { today: "2027-10-01", over: true }).previous!.samePoint).toBe(2);
    // No opening dates for 2027: same date a year earlier.
    const noDates = { ...reg, opens: { "2026": reg.opens["2026"]! } };
    const fams2 = resolveReturning([fam({ season: 2026, enrolled: true, enrolledOn: "2026-01-09" })], noDates);
    expect(returningSummary(fams2, 2027, noDates, { today: "2027-01-08", over: false }).previous!.samePoint).toBe(0);
    expect(returningSummary(fams2, 2027, noDates, { today: "2027-01-09", over: false }).previous!.samePoint).toBe(1);
  });

  it("draws the share re-enrolled by day, stopping the current season at today", () => {
    const fams = resolveReturning(
      [
        fam({ household: "a", enrolled: true, enrolledOn: "2027-01-02" }), // before opening
        fam({ household: "b" }),
        fam({ season: 2026, household: "c", enrolled: true, enrolledOn: "2026-01-10" }),
        fam({ season: 2026, household: "d", enrolled: true, enrolledOn: "2026-01-12" }),
      ],
      reg,
    );
    const curve = returningCurve(fams, [2027, 2026], reg, { season: 2027, today: "2027-01-08", over: false });
    expect(curve[0]).toEqual({ day: -1, "2027": 0.5, "2026": 0 });
    expect(curve.find((r) => r.day === 4)).toEqual({ day: 4, "2027": null, "2026": 1 });
    expect(curve.find((r) => r.day === 3)!["2027"]).toBe(0.5);
  });

  it("segments and filters families", () => {
    const [f] = resolveReturning([fam({ summers: 1, weeks: 6, campers: [{ age: 9, enrolled: false }, { age: 7, enrolled: false }] })], { ...DEFAULT_REGISTRATION, ageOutAfter: 14 });
    expect(returningSegmentKey(f!, "summers")).toBe("1 summer");
    expect(returningSegmentKey(f!, "weeks")).toBe("5–8 weeks");
    expect(returningSegmentKey(f!, "campers")).toBe("2 campers");
    expect(returningSegmentKey(f!, "wave")).toBe("Returning MD");
    expect(filterReturning([f!], { campers: ["1 camper"] })).toHaveLength(0);
    expect(filterReturning([f!], { status: ["Not yet"], state: ["MD"] })).toHaveLength(1);
  });

  it("defaults to the season whose registration is next or under way", () => {
    expect(defaultReturningSeason([2027, 2026, 2025], 2027)).toBe(2027);
    expect(defaultReturningSeason([2026, 2025], 2027)).toBe(2026);
    expect(defaultReturningSeason([2028, 2027], 2026)).toBe(2028);
  });
});
