import { z } from "zod";

/**
 * Camper schools. Campminder has the school as each family typed it, so the
 * same school arrives spelled many ways. Spellings that differ only in case,
 * punctuation, a leading "The", a trailing "School" or "&" vs "and" are
 * grouped automatically; Settings → Schools handles the rest ("SFS" →
 * Sidwell Friends School) and can split anything grouped wrongly. Common
 * abbreviations count as the same word (St. = Saint, Elem. = Elementary,
 * MS = Middle, HS = High).
 */

/** Abbreviations families commonly type, as whole words. */
const WORDS: Record<string, string> = {
  st: "saint",
  elem: "elementary",
  es: "elementary",
  ms: "middle",
  hs: "high",
  acad: "academy",
  sch: "school",
  homeschooled: "homeschool",
  homeschooling: "homeschool",
};

/** Entries that mean "no school given". */
const NOT_A_SCHOOL = new Set(["", "na", "n a", "none", "unknown", "tbd", "no", "x", "other"]);

/** Grouping key for a school as entered; null when it isn't a school at all ("N/A", "-"). */
export function schoolKey(entered: string | null | undefined): string | null {
  const k = (entered ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => WORDS[w] ?? w)
    .join(" ")
    .replace(/\bhome school(ed|ing)?\b/g, "homeschool")
    .replace(/^the\s+/, "")
    .replace(/\s+school$/, "")
    .trim();
  return NOT_A_SCHOOL.has(k) ? null : k;
}

export interface SchoolSpelling {
  /** The school exactly as entered (trimmed). */
  entered: string;
  campers: number;
}

/**
 * School name for every spelling: the Settings override if there is one,
 * else the most common spelling among those with the same key (ties: the
 * longest, so "The Lowell School" beats "Lowell"). Spellings that aren't a
 * school map to null.
 */
export function resolveSchools(spellings: SchoolSpelling[], overrides: Record<string, string>): Map<string, string | null> {
  const best = new Map<string, SchoolSpelling>();
  for (const s of spellings) {
    const k = schoolKey(s.entered);
    if (k === null) continue;
    const b = best.get(k);
    if (!b || s.campers > b.campers || (s.campers === b.campers && s.entered.length > b.entered.length)) best.set(k, s);
  }
  const out = new Map<string, string | null>();
  for (const s of spellings) {
    const k = schoolKey(s.entered);
    out.set(s.entered, overrides[s.entered] ?? (k === null ? null : best.get(k)!.entered));
  }
  return out;
}

/** Spelling (as entered) → school (Settings); spellings not listed are grouped automatically. */
export interface SchoolSettings {
  overrides: Record<string, string>;
}

export const schoolSettingsSchema = z.object({
  overrides: z.record(z.string().max(300), z.string().trim().min(1).max(200)),
});

export type SchoolRow = SchoolSpelling & { school: string | null; origin: "explicit" | "grouped" };
