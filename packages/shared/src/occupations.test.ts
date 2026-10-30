import { describe, expect, it } from "vitest";
import { classifyOccupation, occupationCategories } from "./occupations.js";

describe("parent occupations", () => {
  it("sorts typical answers into categories", () => {
    const cases: Array<[string, string]> = [
      ["Attorney", "Legal"],
      ["Partner, law firm", "Legal"],
      ["lawyer", "Legal"],
      ["Paralegal", "Legal"],
      ["Real estate attorney", "Legal"],
      ["Pediatrician", "Medicine and health"],
      ["Physician", "Medicine and health"],
      ["RN", "Medicine and health"],
      ["Nurse Practitioner", "Medicine and health"],
      ["Dentist", "Medicine and health"],
      ["Psychologist", "Medicine and health"],
      ["Director of Nursing", "Medicine and health"],
      ["Teacher", "Education"],
      ["Professor", "Education"],
      ["MCPS teacher", "Education"],
      ["School principal", "Education"],
      ["Federal government", "Government and military"],
      ["Foreign Service Officer", "Government and military"],
      ["US Army", "Government and military"],
      ["Law enforcement", "Government and military"],
      ["Police officer", "Government and military"],
      ["Senate staffer", "Government and military"],
      ["Investment banker", "Finance"],
      ["Private equity", "Finance"],
      ["CPA", "Finance"],
      ["Financial analyst", "Finance"],
      ["Software engineer", "Technology"],
      ["IT", "Technology"],
      ["Data scientist", "Technology"],
      ["Product manager", "Technology"],
      ["CEO", "Business and management"],
      ["Management consultant", "Business and management"],
      ["Small business owner", "Business and management"],
      ["Chief Operating Officer", "Business and management"],
      ["Marketing director", "Business and management"],
      ["Nonprofit director", "Nonprofit"],
      ["Non-profit", "Nonprofit"],
      ["Rabbi", "Nonprofit"],
      ["Research scientist", "Science and research"],
      ["NIH", "Science and research"],
      ["Economist", "Science and research"],
      ["Journalist", "Arts and media"],
      ["Writer", "Arts and media"],
      ["Graphic designer", "Arts and media"],
      ["Architect", "Real estate and construction"],
      ["Realtor", "Real estate and construction"],
      ["Civil engineer", "Real estate and construction"],
      ["General contractor", "Real estate and construction"],
      ["Electrician", "Trades"],
      ["Chef", "Trades"],
      ["Pilot", "Trades"],
      ["Stay at home mom", "Homemaker"],
      ["SAHM", "Homemaker"],
      ["Homemaker", "Homemaker"],
      ["Mom", "Homemaker"],
      ["Full-time parent", "Homemaker"],
      ["Retired", "Retired"],
      ["Retired attorney", "Retired"],
      ["Astronaut", "Other"],
    ];
    for (const [answer, category] of cases) expect([answer, classifyOccupation(answer)]).toEqual([answer, category]);
  });

  it("skips answers that give no occupation, and never keeps contact details", () => {
    for (const s of ["", "N/A", "none", "-", "Unknown", "parent@example.com", "(301) 555-0100", "12345"]) {
      expect([s, classifyOccupation(s)]).toEqual([s, null]);
    }
  });

  it("gives each family each category once, from up to four parents", () => {
    expect(occupationCategories(["Attorney", "Pediatrician", "lawyer", "N/A"])).toEqual(["Legal", "Medicine and health"]);
    expect(occupationCategories([null, undefined, ""])).toEqual([]);
  });
});
