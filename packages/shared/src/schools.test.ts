import { describe, expect, it } from "vitest";
import {
  applySchoolAction,
  cleanSchool,
  EMPTY_SCHOOL_SETTINGS,
  isNoSchool,
  NOT_A_SCHOOL,
  readSchoolSettings,
  resolveSchoolSpellings,
  type OfficialSchool,
} from "./schools.js";

const official = (id: string, name: string, extra: Partial<OfficialSchool> = {}): OfficialSchool => ({
  id,
  name,
  level: "",
  type: "public",
  state: "MD",
  county: "Montgomery County",
  city: null,
  ...extra,
});
// Official-style names for the test.
const OFFICIAL = [
  official("bannockburn", "Bannockburn Elementary School", { level: "elementary" }),
  official("bradley", "Bradley Hills Elementary School", { level: "elementary" }),
  official("pyle", "Thomas W. Pyle Middle School", { level: "middle" }),
  official("gds", "Georgetown Day School", { type: "private", state: "DC", county: "District of Columbia" }),
  official("jackson-reed", "Jackson-Reed High School", { level: "high", state: "DC", formerNames: ["Wilson High School"] }),
];
const spell = (entered: string, campers = 1) => ({ entered, campers });

describe("schools", () => {
  it("drops answers that aren't a school, so they're never stored", () => {
    for (const bad of [
      "parent@example.com",
      "www.someschool.org",
      "(301) 555-0100",
      "301.555.0100",
      "85",
      "85 lbs",
      "62 pounds",
      "4'2\"",
      "9 years old",
      "20814",
      "123 Made Up Lane",
      "4th grade",
      "Grade 3",
      "K",
      "-",
      "He has a peanut allergy and needs his inhaler before swimming every day please",
      "x".repeat(81),
      "first.last",
      "abc_smith",
    ]) {
      expect(cleanSchool(bad), bad).toBeNull();
    }
    for (const good of ["Sidwell Friends School", "PS 321", "St. Albans", "Holton-Arms", "The Barrie School", "Homeschool", "Lowell", "BCC High School"]) {
      expect(cleanSchool(good), good).toBe(good);
    }
    expect(cleanSchool("  The   Lowell School ")).toBe("The Lowell School");
  });

  it("knows answers that mean no school", () => {
    for (const s of ["N/A", "TBD", "Not sure", "None", "Daycare", "Not yet known (will know in March)", "Middle School"]) expect([s, isNoSchool(s)]).toEqual([s, true]);
    for (const s of ["Homeschool", "Lowell", "School Without Walls"]) expect([s, isNoSchool(s)]).toEqual([s, false]);
  });

  it("matches spellings to actual schools, and groups the rest for review", () => {
    const r = resolveSchoolSpellings(
      [
        spell("Bannockburn", 44),
        spell("Bannockbrun ES"),
        spell("Bradley Hlls ES"),
        spell("Bradley Hills Elementary School", 19),
        spell("Pyle", 36),
        spell("GDS", 42),
        spell("Georgetown Day School", 64),
        spell("Wilson HS", 2),
        spell("NCRC", 37),
        spell("Ncrc", 2),
        spell("N/A", 15),
        spell("Homeschooled", 10),
        spell("Home", 8),
      ],
      OFFICIAL,
      EMPTY_SCHOOL_SETTINGS,
    );
    const school = (id: string) => r.schools.find((s) => s.id === id)?.spellings.map((x) => x.entered).sort();
    expect(school("bannockburn")).toEqual(["Bannockbrun ES", "Bannockburn"]);
    expect(school("bradley")).toEqual(["Bradley Hills Elementary School", "Bradley Hlls ES"]);
    expect(school("pyle")).toEqual(["Pyle"]);
    // Initials are matched in the second pass, once Georgetown Day has campers.
    expect(school("gds")).toEqual(["GDS", "Georgetown Day School"]);
    expect(school("jackson-reed")).toEqual(["Wilson HS"]);
    // Home-schooled campers count as a school of their own.
    expect(school("homeschool")).toEqual(["Home", "Homeschooled"]);
    // Not in the directory: one review item for both spellings, under the more common.
    expect(r.review.map((x) => [x.name, x.spellings.map((s) => s.entered)])).toEqual([["NCRC", ["NCRC", "Ncrc"]]]);
    expect(r.notSchools.map((x) => x.entered)).toEqual(["N/A"]);
    expect(r.bySpelling.get("Pyle")).toEqual({ name: "Thomas W. Pyle Middle School", type: "public", state: "MD", county: "Montgomery County" });
    expect(r.bySpelling.get("Ncrc")?.name).toBe("NCRC");
    expect(r.bySpelling.get("N/A")).toBeNull();
  });

  it("applies admin decisions, which always win", () => {
    let settings = applySchoolAction(EMPTY_SCHOOL_SETTINGS, {
      action: "create",
      spellings: ["NCRC", "NCRC Preschool"],
      school: { name: "National Child Research Center", type: "private", state: "DC", county: null },
    });
    settings = applySchoolAction(settings, { action: "assign", spellings: ["Pyle"], schoolId: "bradley" });
    settings = applySchoolAction(settings, { action: "not-a-school", spellings: ["kathryn mendelsohn"] });
    const r = resolveSchoolSpellings([spell("NCRC", 37), spell("NCRC Preschool", 2), spell("Pyle", 36), spell("kathryn mendelsohn")], OFFICIAL, settings);
    const ncrc = r.schools.find((s) => s.source === "custom")!;
    expect([ncrc.name, ncrc.campers, ncrc.spellings.every((s) => s.status === "confirmed")]).toEqual(["National Child Research Center", 39, true]);
    expect(r.schools.find((s) => s.id === "bradley")?.spellings.map((s) => s.entered)).toEqual(["Pyle"]);
    expect(r.notSchools.map((s) => [s.entered, s.status])).toEqual([["kathryn mendelsohn", "not-a-school"]]);
    expect(settings.assignments["kathryn mendelsohn"]).toBe(NOT_A_SCHOOL);
    // Merging an added school into an official one moves its spellings.
    const merged = applySchoolAction(settings, { action: "merge", from: ncrc.id, into: "gds" });
    expect([merged.schools[ncrc.id], merged.assignments.NCRC]).toEqual([undefined, "gds"]);
    // Reset puts a spelling back on automatic matching.
    expect(applySchoolAction(settings, { action: "reset", spellings: ["Pyle"] }).assignments.Pyle).toBeUndefined();
  });

  it("reads the first version of the settings", () => {
    const s = readSchoolSettings({ overrides: { SFS: "Sidwell Friends School", "Georgetown Day": "georgetown day school" } }, OFFICIAL)!;
    expect(s.assignments["Georgetown Day"]).toBe("gds");
    const sfs = s.assignments.SFS!;
    expect(s.schools[sfs]?.name).toBe("Sidwell Friends School");
    expect(readSchoolSettings({ nonsense: true }, OFFICIAL)).toBeNull();
  });
});
