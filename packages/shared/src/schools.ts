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

/**
 * The school a family entered, or null when the answer isn't a school name at
 * all. Some families type something else in the box (an email address, the
 * child's weight, an answer to another question); those are dropped before
 * anything is stored, so personal details never reach the warehouse.
 */
export function cleanSchool(v: string | null | undefined): string | null {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  if (!s || s === "Undefined") return null;
  const letters = (s.match(/[a-z]/gi) ?? []).length;
  const digits = (s.match(/\d/g) ?? []).length;
  const rejected =
    s.includes("@") || // email address
    /https?:|www\.|\.(com|org|net|edu|gov|us)\b/i.test(s) || // web address
    /\d{3}\D{0,2}\d{3}\D{0,2}\d{4}/.test(s) || // phone number
    letters < 2 || // a number, date or symbol only (weight, ZIP, "-")
    digits >= 5 ||
    /\b\d+(\.\d+)?\s*(lbs?|pounds?|kgs?|kilos?|oz|ft|feet|foot|inch(es)?|in|cm|years?|yrs?|y\/?o)\b|\d\s*['"′″]/i.test(s) || // weight, height, age
    /^\d+\s+\S+.*\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|place|terrace|cir|circle)\b\.?$/i.test(s) || // street address
    /^(grade\s+\d+|\d+(st|nd|rd|th)(\s+grade)?|k|pre-?k|kindergarten)$/i.test(s) || // a grade, not a school
    s.length > 80 ||
    s.split(" ").length > 10; // a sentence answering some other question
  return rejected ? null : s;
}

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
