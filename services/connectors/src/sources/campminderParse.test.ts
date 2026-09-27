import { describe, expect, it } from "vitest";
import { parseSessionDates, parseSessionPrograms, parseSessionStatuses, parseWeek, reportSeason, toSessions, usDate } from "./campminderParse.js";

// Entirely made-up people; shaped like Campminder's export.
const row = (over: Record<string, string> = {}): Record<string, string> => ({
  "Last Name": "Testperson",
  "First Name": "Alex",
  Gender: "Female",
  "Birth Date": "3/15/2016",
  "Camp Grade": "4th",
  "School Grade": "4th",
  "Years as Child Camper": "2",
  "Child Status Post Date": "2/1/2026",
  "Child Status Effective Date": "2/1/2026",
  "Child Application Date": "1/10/2026",
  "Child Session/Status": "Farm Week 3[EN], Fall Farm and Forest Cubs[CN] and Madeira Weeks 5-6[EN]",
  "Enrolled Child Sessions With Dates (columnar)": "Farm Week 3 (06/29/2026-07/03/2026)\nMadeira Weeks 5-6 (07/06/2026-07/17/2026)",
  "Enrolled Child Sessions/Programs": "Farm Week 3/Explorers - Quest and Madeira Weeks 5-6/Sailing and Kayaking",
  "Primary Childhood HomeAddr1": "1 Made Up Lane",
  "Primary Childhood HomeCity": "Nowhere",
  "Primary Childhood HomeState": "MD",
  "Primary Childhood HomeZip": "00000",
  "F1P1 Occupation": "Tester",
  "Primary Childhood ID": "5550001",
  PersonID: "90000001",
  ...over,
});

const KEY = "k".repeat(40);

describe("campminder parsing", () => {
  it("splits sessions on status markers, not on 'and' inside names", () => {
    expect(parseSessionStatuses("Farm Week 3[EN], Fall Farm and Forest Cubs[CN] and Madeira Weeks 5-6[EN]")).toEqual([
      { name: "Farm Week 3", code: "EN" },
      { name: "Fall Farm and Forest Cubs", code: "CN" },
      { name: "Madeira Weeks 5-6", code: "EN" },
    ]);
    expect(parseSessionStatuses("Winter Group Lessons[EN] and Spring Group Lessons[WL]").map((s) => s.name)).toEqual([
      "Winter Group Lessons",
      "Spring Group Lessons",
    ]);
  });

  it("reads weeks, dates and programs", () => {
    expect(parseWeek("Madeira Weeks 5-6")).toEqual({ group: "Madeira", start: 5, end: 6 });
    expect(parseWeek("Riley's Week 10")).toEqual({ group: "Riley's", start: 10, end: 10 });
    expect(parseWeek("Fall Saddle Club MONDAY")).toEqual({ group: "Fall Saddle Club MONDAY", start: null, end: null });
    expect(parseSessionDates("Farm Week 3 (06/29/2026-07/03/2026)").get("Farm Week 3")).toEqual({ start: "2026-06-29", end: "2026-07-03" });
    const p = parseSessionPrograms("Farm Week 3/Explorers - Quest and Madeira Weeks 5-6/Sailing and Kayaking", ["Farm Week 3", "Madeira Weeks 5-6"]);
    expect(p.get("Farm Week 3")).toBe("Explorers - Quest");
    expect(p.get("Madeira Weeks 5-6")).toBe("Sailing and Kayaking");
    expect(usDate("7/4/2026")).toBe("2026-07-04");
    expect(usDate("13/40/2026")).toBeNull();
  });

  it("produces one row per camper-session with only safe fields", () => {
    const s = toSessions([row()], KEY, 2026);
    expect(s).toHaveLength(3);
    const text = JSON.stringify(s);
    // Street and city never leave the parser (homes are placed by coordinates); ZIP is kept for the map.
    for (const secret of ["Testperson", "Alex", "Made Up Lane", "Nowhere", "Tester", "90000001", "5550001", "2016-03-15"]) {
      expect(text).not.toContain(secret);
    }
    expect(s[0]!.homeZip).toBe("00000");
    expect(s[0]).toMatchObject({
      season: 2026, sessionGroup: "Farm", isWeekly: true, weekStart: 3, sessionStart: "2026-06-29", program: "Explorers - Quest",
      status: "Enrolled", gender: "Female", ageAtSeason: 10, homeState: "MD", yearsAsCamper: 2, applicationDate: "2026-01-10",
    });
    expect(s[1]).toMatchObject({ sessionGroup: "Fall Farm and Forest Cubs", isWeekly: false, status: "Cancelled", sessionStart: null });
    expect(s[0]!.camperHash).toHaveLength(64);
  });

  it("gives cancelled sessions dates known from other campers", () => {
    const other = row({ PersonID: "90000002", "Child Session/Status": "Farm Week 3[CN]", "Enrolled Child Sessions With Dates (columnar)": "" });
    const s = toSessions([row(), other], KEY, 2026).filter((x) => x.statusCode === "CN" && x.sessionName === "Farm Week 3");
    expect(s[0]!.sessionStart).toBe("2026-06-29");
  });

  it("keeps the current status when a camper lists a session twice", () => {
    for (const statuses of ["Farm Week 3[CN], Farm Week 3[EN]", "Farm Week 3[EN], Farm Week 3[CN]"]) {
      const s = toSessions([row({ "Child Session/Status": statuses })], KEY, 2026);
      expect(s).toHaveLength(1);
      expect(s[0]!.statusCode).toBe("EN");
    }
  });

  it("detects the season from session dates", () => {
    expect(reportSeason([row()])).toBe(2026);
    expect(reportSeason([row({ "Enrolled Child Sessions With Dates (columnar)": "Farm Week 1 (06/14/2027-06/18/2027)" })])).toBe(2027);
  });

  it("isn't moved by a few fall programs in the same report", () => {
    const fall = row({ "Enrolled Child Sessions With Dates (columnar)": "Fall Saddle Club MONDAY (09/14/2026-11/16/2026)" });
    expect(reportSeason([row(), row(), fall])).toBe(2026);
  });

  it("changes the row hash only when stored fields change", () => {
    const a = toSessions([row()], KEY, 2026)[0]!;
    const b = toSessions([row({ "First Name": "Different" })], KEY, 2026)[0]!;
    const c = toSessions([row({ "Child Session/Status": "Farm Week 3[WD]" })], KEY, 2026)[0]!;
    expect(b.rowHash).toBe(a.rowHash);
    expect(c.rowHash).not.toBe(a.rowHash);
  });
});
