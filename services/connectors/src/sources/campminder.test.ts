import { describe, expect, it } from "vitest";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "../core/memory.js";
import { runSync } from "../core/runner.js";
import { EnvSecretStore } from "../core/secrets.js";
import { CampminderConnector, type CurrentRows, type SheetReader } from "./campminder.js";

const HEADER = ["PersonID", "Gender", "Birth Date", "Child Application Date", "Child Session/Status", "Enrolled Child Sessions With Dates (columnar)", "Primary Childhood ID"];
const camper = (id: string, status: string, year = 2026) => [id, "Male", "5/5/2015", `1/2/${year}`, status, `Farm Week 1 (06/15/${year}-06/19/${year})`, `F${id}`];

class FakeSheet implements SheetReader {
  /** Tabs of the history sheet (sheet id "history"). */
  history: Record<string, string[][]> = {};
  reads: string[] = [];
  constructor(public values: string[][]) {}
  async read(sheetId: string, tab: string) {
    this.reads.push(`${sheetId}/${tab}`);
    return sheetId === "history" ? this.history[tab]! : this.values;
  }
  async tabs() {
    return Object.keys(this.history);
  }
}

/** Mirrors what's been written, like the BigQuery table would. */
class StoredRows implements CurrentRows {
  constructor(private readonly writer: MemoryRawWriter) {}
  async load(season: number) {
    const latest = new Map<string, { hash: string; deleted: boolean }>();
    for (const { record } of this.writer.rows) {
      const p = record.payload as { season: number; rowHash?: string };
      if (p.season !== season) continue;
      latest.set(record.recordId, { hash: p.rowHash ?? "", deleted: !!record.isDeleted });
    }
    return new Map([...latest].filter(([, v]) => !v.deleted).map(([k, v]) => [k, v.hash]));
  }
}

function setup(values: string[][], env: Record<string, string> = {}, historySheetId?: string) {
  const writer = new MemoryRawWriter();
  const deps = { writer, state: new MemoryStateStore(), runLog: new MemoryRunLog() };
  const sheet = new FakeSheet(values);
  const c = new CampminderConnector({
    secrets: new EnvSecretStore({ PSEUDONYMIZATION_KEY: "k".repeat(40), CAMPMINDER_SHEET_ID: "sheet", ...env }),
    sheet,
    current: new StoredRows(writer),
    tab: "Sheet1",
    historySheetId,
  });
  return { c, deps, writer, sheet };
}

const many = (n: number, status = "Farm Week 1[EN]", year = 2026) => Array.from({ length: n }, (_, i) => camper(String(1000 + i), status, year));

describe("campminder connector", () => {
  it("imports everything first, then only what changed", async () => {
    const { c, deps, writer, sheet } = setup([HEADER, ...many(10)]);
    await runSync(c, deps, "incremental");
    expect(writer.rows).toHaveLength(10);

    // Unchanged sheet: nothing read beyond the hash, nothing written.
    await runSync(c, deps, "incremental");
    expect(writer.rows).toHaveLength(10);

    // One camper withdraws, one new camper, one camper removed.
    const next = many(10);
    next[0] = camper("1000", "Farm Week 1[WD]");
    next.splice(9, 1, camper("2000", "Farm Week 1[EN]"));
    sheet.values = [HEADER, ...next];
    await runSync(c, deps, "incremental");
    const added = writer.rows.slice(10).map((r) => ({ deleted: !!r.record.isDeleted, status: (r.record.payload as { status?: string }).status }));
    expect(added).toEqual(expect.arrayContaining([
      { deleted: false, status: "Withdrawn" },
      { deleted: false, status: "Enrolled" },
      { deleted: true, status: undefined },
    ]));
    expect(added).toHaveLength(3);
  });

  it("refuses a report that looks half-written", async () => {
    const { c, deps, writer, sheet } = setup([HEADER, ...many(10)]);
    await runSync(c, deps, "incremental");
    sheet.values = [HEADER, ...many(3)];
    const r = await runSync(c, deps, "incremental");
    expect(r.status).toBe("error");
    expect(r.error).toContain("looks incomplete");
    expect(writer.rows).toHaveLength(10);
  });

  it("keeps last season when the sheet switches to the next one", async () => {
    const { c, deps, writer, sheet } = setup([HEADER, ...many(5)]);
    await runSync(c, deps, "incremental");
    sheet.values = [HEADER, ...many(2, "Farm Week 1[EN]", 2027)];
    await runSync(c, deps, "incremental");
    const newRows = writer.rows.slice(5);
    expect(newRows).toHaveLength(2);
    expect(newRows.every((r) => (r.record.payload as { season: number }).season === 2027 && !r.record.isDeleted)).toBe(true);
  });

  it("never stores names, birth dates or ids", async () => {
    const { c, deps, writer } = setup([HEADER, camper("98765432", "Farm Week 1[EN]")]);
    await runSync(c, deps, "incremental");
    const text = JSON.stringify(writer.rows);
    expect(text).not.toContain("98765432");
    expect(text).not.toContain("2015-05-05");
    expect(text).not.toContain("F98765432");
  });

  it("is 'not connected' without a sheet id, and explains missing columns", async () => {
    const none = new CampminderConnector({ secrets: new EnvSecretStore({ PSEUDONYMIZATION_KEY: "k".repeat(40) }), sheet: new FakeSheet([]), current: { load: async () => new Map() }, tab: "Sheet1" });
    const deps = { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
    expect(await runSync(none, deps, "incremental")).toMatchObject({ notConfigured: true });
    const { c, deps: d2 } = setup([["Name", "Other"], ["a", "b"]]);
    const r = await runSync(c, d2, "incremental");
    expect(r.error).toContain("PersonID");
  });

  it("honors a season override", async () => {
    const { c, deps, writer } = setup([HEADER, ...many(1)], { CAMPMINDER_SEASON: "2031" });
    await runSync(c, deps, "incremental");
    expect((writer.rows[0]!.record.payload as { season: number }).season).toBe(2031);
  });

  describe("history sheet", () => {
    const seasonOf = (w: MemoryRawWriter) => {
      const out: Record<number, number> = {};
      for (const { record } of w.rows) {
        const season = (record.payload as { season: number }).season;
        out[season] = (out[season] ?? 0) + 1;
      }
      return out;
    };

    it("imports each year tab as its season, once", async () => {
      const { c, deps, writer, sheet } = setup([HEADER, ...many(4)], {}, "history");
      sheet.history = {
        "2022": [HEADER, ...many(2, "Farm Week 1[EN]", 2022)],
        "2023": [HEADER, ...many(3, "Farm Week 1[EN]", 2023)],
        Notes: [["anything"]],
        "2026": [HEADER, ...many(1, "Farm Week 1[EN]", 2026)],
      };
      const r = await runSync(c, deps, "incremental");
      expect(r.status).toBe("ok");
      // The daily sheet owns 2026, so the history tab for it is ignored.
      expect(seasonOf(writer)).toEqual({ 2022: 2, 2023: 3, 2026: 4 });
      expect(sheet.reads).not.toContain("history/Notes");

      sheet.reads = [];
      await runSync(c, deps, "incremental");
      expect(writer.rows).toHaveLength(9);

      // A removed tab keeps its season as imported.
      delete sheet.history["2022"];
      await runSync(c, deps, "incremental");
      expect(writer.rows.filter((x) => x.record.isDeleted)).toHaveLength(0);
    });

    it("refuses a report in the wrong tab without holding up the rest", async () => {
      const { c, deps, writer, sheet } = setup([HEADER, ...many(4)], {}, "history");
      sheet.history = {
        "2022": [HEADER, ...many(2, "Farm Week 1[EN]", 2023)],
        "2024": [HEADER, ...many(3, "Farm Week 1[EN]", 2024)],
      };
      const r = await runSync(c, deps, "incremental");
      expect(r.status).toBe("error");
      expect(r.error).toContain('History tab "2022" has sessions from season 2023');
      expect(seasonOf(writer)).toEqual({ 2024: 3, 2026: 4 });
    });
  });
});
