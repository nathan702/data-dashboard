import { describe, expect, it } from "vitest";
import { resolveSchools, schoolKey } from "./schools.js";

describe("schools", () => {
  it("groups spellings that differ only in form", () => {
    for (const s of ["Lowell", "The Lowell School", "lowell school", "LOWELL"]) expect(schoolKey(s)).toBe("lowell");
    expect(schoolKey("St. Albans")).toBe(schoolKey("St Albans"));
    expect(schoolKey("Burgundy Farm Country Day School")).toBe(schoolKey("Burgundy Farm Country Day"));
    expect(schoolKey("Holton-Arms")).toBe(schoolKey("Holton Arms School"));
    expect(schoolKey("Sidwell Friends & Co")).toBe(schoolKey("Sidwell Friends and Co"));
    expect(schoolKey("St Brigids")).toBe(schoolKey("Saint Brigid's School"));
    expect(schoolKey("maple grove elem.")).toBe(schoolKey("Maple Grove Elementary School"));
    expect(schoolKey("Oak Hill MS")).toBe(schoolKey("Oak Hill Middle School"));
    expect(schoolKey("Home school")).toBe(schoolKey("Homeschool"));
    expect(schoolKey("Homeschooled")).toBe("homeschool");
    // Different levels stay apart.
    expect(schoolKey("Lowell Middle School")).not.toBe(schoolKey("Lowell High School"));
    for (const s of ["N/A", "none", " - ", "", null]) expect(schoolKey(s)).toBeNull();
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
