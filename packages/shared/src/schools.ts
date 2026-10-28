import { z } from "zod";

/**
 * Camper schools. Campminder has the school as each family typed it, so the
 * same school arrives spelled many ways. Spellings that differ only in case,
 * punctuation, a leading "The", a trailing "School" or "&" vs "and" are
 * grouped automatically; Settings → Schools handles the rest ("SFS" →
 * Sidwell Friends School) and can split anything grouped wrongly. Common
 * abbreviations count as the same word (St. = Saint, Elem. = Elementary,
 * MS = Middle, HS = High), filler words ("of", "School") and plurals don't
 * matter, and a name without its level joins the one school by that name.
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

/** Words that don't tell schools apart ("Burnsville School of Science and Art" = "Burnsville Science and Arts"). */
const FILLER = new Set(["the", "of", "and", "school", "schools", "for", "at", "a"]);

/** School levels, when they end the name ("Carderock Springs ES" → Carderock Springs, elementary). */
const LEVELS = new Set(["elementary", "middle", "high"]);

/** Plural → singular, so "Arts" = "Art" ("Lewis", "Holy Cross", "Campus" stay). */
const singular = (w: string) => (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);

/**
 * A school name reduced to what identifies it: the distinctive words (base)
 * and its level when the name ends in one. Null when it isn't a school ("N/A").
 */
export function schoolParts(entered: string | null | undefined): { base: string; level: string } | null {
  const plain = (entered ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => WORDS[w] ?? w)
    .join(" ")
    .replace(/\bhome school(ed|ing)?\b/g, "homeschool");
  if (NOT_A_SCHOOL.has(plain)) return null;
  const words = plain
    .split(" ")
    .filter((w) => w && !FILLER.has(w))
    .map(singular);
  const level = words.length > 1 && LEVELS.has(words[words.length - 1]!) ? words.pop()! : "";
  const base = words.join(" ");
  return !base || NOT_A_SCHOOL.has(base) ? null : { base, level };
}

/** Grouping key for a school as entered (spellings with the same key are one school); null when it isn't a school. */
export function schoolKey(entered: string | null | undefined): string | null {
  const p = schoolParts(entered);
  return p ? `${p.base}|${p.level}` : null;
}

export interface SchoolSpelling {
  /** The school exactly as entered (trimmed). */
  entered: string;
  campers: number;
}

/**
 * School name for every spelling: the Settings override if there is one,
 * else the most common spelling in its group (ties: the longest, so "The
 * Lowell School" beats "Lowell"). Spellings with the same key are a group;
 * a name without a level ("Burning Tree") joins its school's group when only
 * one level exists for that name ("Burning Tree Elementary"), and stays apart
 * when it's ambiguous (both "X Elementary" and "X Middle"). Spellings that
 * aren't a school map to null.
 */
export function resolveSchools(spellings: SchoolSpelling[], overrides: Record<string, string>): Map<string, string | null> {
  const parts = new Map(spellings.map((s) => [s.entered, schoolParts(s.entered)]));
  const levels = new Map<string, Set<string>>();
  for (const p of parts.values()) if (p?.level) levels.set(p.base, (levels.get(p.base) ?? new Set()).add(p.level));
  const groupOf = (p: { base: string; level: string }) => {
    const only = levels.get(p.base);
    return `${p.base}|${p.level || (only?.size === 1 ? [...only][0] : "")}`;
  };
  const best = new Map<string, SchoolSpelling>();
  for (const s of spellings) {
    const p = parts.get(s.entered);
    if (!p) continue;
    const g = groupOf(p);
    const b = best.get(g);
    if (!b || s.campers > b.campers || (s.campers === b.campers && s.entered.length > b.entered.length)) best.set(g, s);
  }
  const out = new Map<string, string | null>();
  for (const s of spellings) {
    const p = parts.get(s.entered);
    out.set(s.entered, overrides[s.entered] ?? (p ? best.get(groupOf(p))!.entered : null));
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
