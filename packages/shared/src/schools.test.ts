import { describe, expect, it } from "vitest";
import { cleanSchool, resolveSchools, schoolKey } from "./schools.js";

describe("schools", () => {
  it("groups spellings that differ only in form", () => {
    for (const s of ["Lowell", "The Lowell School", "lowell school", "LOWELL"]) expect(schoolKey(s)).toBe("lowell|");
    expect(schoolKey("St. Albans")).toBe(schoolKey("St Albans"));
    expect(schoolKey("Burgundy Farm Country Day School")).toBe(schoolKey("Burgundy Farm Country Day"));
    expect(schoolKey("Holton-Arms")).toBe(schoolKey("Holton Arms School"));
    expect(schoolKey("Sidwell Friends & Co")).toBe(schoolKey("Sidwell Friends and Co"));
    expect(schoolKey("St Brigids")).toBe(schoolKey("Saint Brigid's School"));
    expect(schoolKey("maple grove elem.")).toBe(schoolKey("Maple Grove Elementary School"));
    expect(schoolKey("Oak Hill MS")).toBe(schoolKey("Oak Hill Middle School"));
    expect(schoolKey("Home school")).toBe(schoolKey("Homeschool"));
    expect(schoolKey("Homeschooled")).toBe("homeschool|");
    expect(schoolKey("Burnsville school of science and art")).toBe(schoolKey("Burnsville science and arts"));
    expect(schoolKey("Carderock Springs ES")).toBe(schoolKey("Carderock Springs Elementary"));
    // "High" starting a name isn't a level.
    expect(schoolKey("High Point Elementary")).toBe("high point|elementary");
    // Different levels stay apart.
    expect(schoolKey("Lowell Middle School")).not.toBe(schoolKey("Lowell High School"));
    for (const s of ["N/A", "none", " - ", "", null]) expect(schoolKey(s)).toBeNull();
  });

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
    ]) {
      expect(cleanSchool(bad), bad).toBeNull();
    }
    for (const good of ["Sidwell Friends School", "PS 321", "St. Albans", "Holton-Arms", "The Barrie School", "Homeschool", "Lowell", "BCC High School"]) {
      expect(cleanSchool(good), good).toBe(good);
    }
    expect(cleanSchool("  The   Lowell School ")).toBe("The Lowell School");
  });

  it("lets a name without its level join the one school by that name", () => {
    const m = resolveSchools(
      [
        { entered: "Burning Tree Elementary", campers: 10 },
        { entered: "Burning Tree", campers: 4 },
        { entered: "Carderock Springs Elementary", campers: 8 },
        { entered: "Carderock Springs", campers: 3 },
        { entered: "Carderock Springs ES", campers: 2 },
        { entered: "Lowell Middle School", campers: 5 },
        { entered: "Lowell High School", campers: 5 },
        { entered: "Lowell", campers: 2 },
      ],
      {},
    );
    expect(m.get("Burning Tree")).toBe("Burning Tree Elementary");
    expect(m.get("Carderock Springs")).toBe("Carderock Springs Elementary");
    expect(m.get("Carderock Springs ES")).toBe("Carderock Springs Elementary");
    // Ambiguous: two Lowells with different levels, so plain "Lowell" is left for Settings.
    expect(m.get("Lowell Middle School")).toBe("Lowell Middle School");
    expect(m.get("Lowell High School")).toBe("Lowell High School");
    expect(m.get("Lowell")).toBe("Lowell");
  });

  it("names each group by its most common spelling, and Settings wins", () => {
    const spellings = [
      { entered: "Lowell", campers: 3 },
      { entered: "The Lowell School", campers: 9 },
      { entered: "SFS", campers: 2 },
      { entered: "Sidwell Friends School", campers: 20 },
      { entered: "N/A", campers: 4 },
    ];
    const m = resolveSchools(spellings, { SFS: "Sidwell Friends School" });
    expect(m.get("Lowell")).toBe("The Lowell School");
    expect(m.get("SFS")).toBe("Sidwell Friends School");
    expect(m.get("N/A")).toBeNull();
    expect(resolveSchools(spellings, { Lowell: "Lowell (DC)" }).get("Lowell")).toBe("Lowell (DC)");
  });
});
