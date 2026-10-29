import { z } from "zod";
import {
  AUTO_MATCH,
  nameScore,
  parseSchool,
  SchoolMatcher,
  SUGGEST,
  WordWeights,
  type MatchReason,
  type SchoolCandidate,
  type SchoolLevel,
  type SchoolMatch,
} from "./schoolMatch.js";

/**
 * Camper schools. Campminder has the school as each family typed it, so the
 * same school arrives spelled many ways. Each spelling is matched to an
 * actual school (the official directory, or one created on Settings →
 * Schools) by the fuzzy matcher in schoolMatch.ts: confident matches are
 * made automatically, the rest wait in a review list, grouped with their
 * look-alikes, until an admin settles them.
 */

/** Answers that say no school was given ("N/A", "TBD", "Not sure", "Daycare"): counted as no school, never reviewed. */
const NO_SCHOOL =
  /^(n\/?a|na|none|no|nope|tbd|tba|unknown|not sure|unsure|need info|other|x|school|elementary( school)?|middle( school)?|high( ?school)?|pre-? ?school|preschool|pre-?k|daycare|day care|home daycare|family daycare|toddler|not (yet )?(known|in school|enrolled|in kindergarten).*)$/i;

/** True when an answer (already through cleanSchool) says no school was given. */
export const isNoSchool = (entered: string) => NO_SCHOOL.test(entered.replace(/[.!]+$/, "").trim());

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
    /^[a-z0-9]+[._][a-z0-9._]+$/i.test(s) || // a username ("first.last", "abc_smith")
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

export interface SchoolSpelling {
  /** The school exactly as entered (trimmed). */
  entered: string;
  campers: number;
}

export type SchoolType = "public" | "private" | "other";

/** A school from the official directory (U.S. Department of Education, NCES). */
export interface OfficialSchool {
  /** "nces-<NCES id>". */
  id: string;
  name: string;
  level: SchoolLevel;
  type: "public" | "private";
  /** Two-letter state, DC included. */
  state: string;
  county: string | null;
  city: string | null;
  /** Earlier names (e.g. Wilson High School before it became Jackson-Reed). */
  formerNames?: string[];
  /** In a county most camp families come from (see scripts/fetch_official_schools.py). */
  nearby?: boolean;
}

/** A school added on Settings → Schools: not in the official directory (preschools, schools elsewhere). */
export interface CustomSchool {
  name: string;
  type: SchoolType | null;
  state: string | null;
  county: string | null;
}

/** Schools every list has: home-schooled campers count as a school of their own. */
export const BUILTIN_SCHOOLS: ReadonlyArray<{ id: string; name: string; type: SchoolType; aliases: string[] }> = [
  { id: "homeschool", name: "Homeschool", type: "other", aliases: ["Home", "Home school", "Homeschooled", "Home schooled", "Homeschooling"] },
];

/** Marks a spelling that isn't a school at all ("Hahaha", "Germany", a person's name). */
export const NOT_A_SCHOOL = "not-a-school";

/** What admins have decided on Settings → Schools. Everything else is matched automatically. */
export interface SchoolSettings {
  version: 2;
  /** Schools added by hand, by id ("c-…"). */
  schools: Record<string, CustomSchool>;
  /** Spelling (exactly as entered) → school id (official or added), or NOT_A_SCHOOL. */
  assignments: Record<string, string>;
}

export const EMPTY_SCHOOL_SETTINGS: SchoolSettings = { version: 2, schools: {}, assignments: {} };

const customSchoolSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(["public", "private", "other"]).nullable().default(null),
  state: z.string().trim().max(40).nullable().default(null),
  county: z.string().trim().max(80).nullable().default(null),
});

export const schoolSettingsSchema = z.object({
  version: z.literal(2),
  schools: z.record(z.string().regex(/^c-[a-z0-9-]{1,60}$/), customSchoolSchema),
  assignments: z.record(z.string().min(1).max(300), z.string().min(1).max(80)),
});

/** The first version kept spelling → name; each name becomes a school (the official one when the name is exactly it). */
const legacySchoolSettingsSchema = z.object({ overrides: z.record(z.string(), z.string()) });

/** Settings as stored, from either version; null when unreadable. */
export function readSchoolSettings(stored: unknown, official: OfficialSchool[]): SchoolSettings | null {
  const v2 = schoolSettingsSchema.safeParse(stored);
  if (v2.success) return v2.data;
  const legacy = legacySchoolSettingsSchema.safeParse(stored);
  if (!legacy.success) return null;
  const byName = new Map(official.map((o) => [o.name.toLowerCase(), o.id]));
  const out: SchoolSettings = { version: 2, schools: {}, assignments: {} };
  for (const [entered, name] of Object.entries(legacy.data.overrides)) {
    let id = byName.get(name.trim().toLowerCase());
    if (!id) {
      id = customSchoolId(name);
      out.schools[id] ??= { name: name.trim(), type: null, state: null, county: null };
    }
    out.assignments[entered] = id;
  }
  return out;
}

/** A stable id for a school added by hand. */
export function customSchoolId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "school";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `c-${slug}-${h.toString(36)}`;
}

/** Changes admins make on Settings → Schools. */
export const schoolActionSchema = z.discriminatedUnion("action", [
  // These spellings are this school (official or added).
  z.object({ action: z.literal("assign"), spellings: z.array(z.string().min(1).max(300)).min(1).max(500), schoolId: z.string().min(1).max(80) }),
  // A school that isn't in the official directory, with these spellings.
  z.object({
    action: z.literal("create"),
    spellings: z.array(z.string().min(1).max(300)).max(500),
    school: customSchoolSchema,
  }),
  // These answers aren't schools.
  z.object({ action: z.literal("not-a-school"), spellings: z.array(z.string().min(1).max(300)).min(1).max(500) }),
  // Back to automatic matching.
  z.object({ action: z.literal("reset"), spellings: z.array(z.string().min(1).max(300)).min(1).max(500) }),
  // Rename or update an added school.
  z.object({ action: z.literal("update"), schoolId: z.string().regex(/^c-/), school: customSchoolSchema }),
  // Move everything from one school to another and remove the first (added schools only).
  z.object({ action: z.literal("merge"), from: z.string().regex(/^c-/), into: z.string().min(1).max(80) }),
]);
export type SchoolAction = z.infer<typeof schoolActionSchema>;

/** Apply one admin change to the settings. */
export function applySchoolAction(settings: SchoolSettings, a: SchoolAction): SchoolSettings {
  const next: SchoolSettings = { version: 2, schools: { ...settings.schools }, assignments: { ...settings.assignments } };
  switch (a.action) {
    case "assign":
      for (const s of a.spellings) next.assignments[s] = a.schoolId;
      break;
    case "create": {
      const id = customSchoolId(a.school.name);
      next.schools[id] = a.school;
      for (const s of a.spellings) next.assignments[s] = id;
      break;
    }
    case "not-a-school":
      for (const s of a.spellings) next.assignments[s] = NOT_A_SCHOOL;
      break;
    case "reset":
      for (const s of a.spellings) delete next.assignments[s];
      break;
    case "update":
      if (next.schools[a.schoolId]) next.schools[a.schoolId] = a.school;
      break;
    case "merge":
      for (const [s, id] of Object.entries(next.assignments)) if (id === a.from) next.assignments[s] = a.into;
      delete next.schools[a.from];
      break;
  }
  return next;
}

export type SpellingStatus = "confirmed" | "auto" | "review" | "no-school" | "not-a-school";

export interface ResolvedSpelling extends SchoolSpelling {
  status: SpellingStatus;
  /** The school it's matched to (confirmed or auto), or suggested for (review). */
  schoolId: string | null;
  confidence: number;
}

export interface ResolvedSchool {
  id: string;
  name: string;
  /** Official directory, added on Settings, or built in (Homeschool). */
  source: "official" | "custom" | "builtin";
  type: SchoolType | null;
  level: SchoolLevel;
  state: string | null;
  county: string | null;
  city: string | null;
  campers: number;
  spellings: ResolvedSpelling[];
}

/** Spellings that look like the same school, waiting for an admin. */
export interface SchoolReviewItem {
  /** Stable while its top spelling stays the same. */
  key: string;
  /** The most common spelling: what reports show until it's settled. */
  name: string;
  campers: number;
  spellings: ResolvedSpelling[];
  /** Best actual school, when one is worth suggesting. */
  suggestion: { id: string; name: string; confidence: number } | null;
  alternatives: Array<{ id: string; name: string }>;
  reason: MatchReason | "new";
}

export interface SchoolResolution {
  schools: ResolvedSchool[];
  review: SchoolReviewItem[];
  /** Marked not a school, or no school given. */
  notSchools: ResolvedSpelling[];
  /** Each spelling's school for reports (null: no school). */
  bySpelling: Map<string, SchoolForReports | null>;
}

export interface SchoolForReports {
  name: string;
  type: SchoolType | null;
  state: string | null;
  county: string | null;
}

/**
 * Settle every spelling: an admin's decision wins; otherwise the matcher
 * assigns confident matches (in two passes, so spellings matched in the
 * first help match the rest), and what's left is grouped with its
 * look-alikes into review items.
 */
export function resolveSchoolSpellings(spellings: SchoolSpelling[], official: OfficialSchool[], settings: SchoolSettings): SchoolResolution {
  const info = new Map<string, Omit<ResolvedSchool, "campers" | "spellings">>();
  for (const o of official) {
    info.set(o.id, { id: o.id, name: o.name, source: "official", type: o.type, level: o.level, state: o.state, county: o.county, city: o.city });
  }
  for (const [id, c] of Object.entries(settings.schools)) {
    info.set(id, { id, name: c.name, source: "custom", type: c.type, level: "", state: c.state, county: c.county, city: null });
  }
  for (const b of BUILTIN_SCHOOLS) info.set(b.id, { id: b.id, name: b.name, source: "builtin", type: b.type, level: "", state: null, county: null, city: null });

  const resolved = new Map<string, ResolvedSpelling>();
  const pending: SchoolSpelling[] = [];
  for (const s of [...spellings].sort((a, b) => b.campers - a.campers || a.entered.localeCompare(b.entered))) {
    const decided = settings.assignments[s.entered];
    if (decided === NOT_A_SCHOOL) resolved.set(s.entered, { ...s, status: "not-a-school", schoolId: null, confidence: 1 });
    else if (decided && info.has(decided)) resolved.set(s.entered, { ...s, status: "confirmed", schoolId: decided, confidence: 1 });
    else if (isNoSchool(s.entered)) resolved.set(s.entered, { ...s, status: "no-school", schoolId: null, confidence: 1 });
    else pending.push(s);
  }

  // Word weights come from the official names when there are enough of them, else from the spellings themselves.
  const weightNames = official.length >= 300 ? official.map((o) => o.name) : spellings.map((s) => s.entered);
  const weights = new WordWeights(
    weightNames.map((n) => parseSchool(n)?.tokens).filter((t): t is string[] => !!t),
  );
  const nearbyIds = new Set(official.filter((o) => o.nearby).map((o) => o.id));
  const formerNames = new Map<string, string[]>([...official.map((o) => [o.id, o.formerNames ?? []] as const), ...BUILTIN_SCHOOLS.map((b) => [b.id, b.aliases] as const)]);
  const matcherFor = () => {
    const aliases = new Map<string, string[]>();
    const likely = new Map<string, string[]>();
    const campers = new Map<string, number>();
    for (const r of resolved.values()) {
      if (!r.schoolId || (r.status !== "confirmed" && r.status !== "auto")) continue;
      const into = r.status === "confirmed" ? aliases : likely;
      into.set(r.schoolId, [...(into.get(r.schoolId) ?? []), r.entered]);
      campers.set(r.schoolId, (campers.get(r.schoolId) ?? 0) + r.campers);
    }
    const candidates: SchoolCandidate[] = [...info.values()].map((s) => ({
      id: s.id,
      name: s.name,
      level: s.level,
      aliases: aliases.get(s.id) ?? [],
      likelyAliases: likely.get(s.id) ?? [],
      formerNames: formerNames.get(s.id) ?? [],
      campers: campers.get(s.id) ?? 0,
      // Only official schools can be "far" (when the list marks any as nearby); added and built-in ones are local.
      nearby: s.source !== "official" || !nearbyIds.size || nearbyIds.has(s.id),
    }));
    return new SchoolMatcher(candidates, weights);
  };

  let matches = new Map<string, SchoolMatch>();
  for (let pass = 0; pass < 2 && pending.length; pass++) {
    const matcher = matcherFor();
    matches = new Map();
    for (const s of pending) {
      if (resolved.has(s.entered)) continue;
      const m = matcher.match(s.entered);
      matches.set(s.entered, m);
      if (m.id && m.confidence >= AUTO_MATCH) resolved.set(s.entered, { ...s, status: "auto", schoolId: m.id, confidence: m.confidence });
    }
  }

  // Group what's left with its look-alikes, so one decision settles every spelling of a school.
  const left = pending.filter((s) => !resolved.has(s.entered));
  const groups = groupLookAlikes(left, weights);
  const review: SchoolReviewItem[] = groups.map((g) => {
    const top = g[0]!;
    // The suggestion: the actual school the group's campers point to most (then the surest).
    const votes = new Map<string, { campers: number; m: SchoolMatch }>();
    for (const s of g) {
      const m = matches.get(s.entered);
      if (!m?.id || m.confidence < SUGGEST) continue;
      const v = votes.get(m.id);
      votes.set(m.id, { campers: (v?.campers ?? 0) + s.campers, m: !v || m.confidence > v.m.confidence ? m : v.m });
    }
    const best = [...votes.values()].sort((a, b) => b.campers - a.campers || b.m.confidence - a.m.confidence)[0]?.m ?? null;
    const items: ResolvedSpelling[] = g.map((s) => ({
      ...s,
      status: "review",
      schoolId: best?.id ?? null,
      confidence: matches.get(s.entered)?.confidence ?? 0,
    }));
    for (const r of items) resolved.set(r.entered, r);
    return {
      key: `r-${customSchoolId(top.entered).slice(2)}`,
      name: top.entered,
      campers: g.reduce((t, s) => t + s.campers, 0),
      spellings: items,
      suggestion: best?.id ? { id: best.id, name: info.get(best.id)!.name, confidence: best.confidence } : null,
      alternatives: (best?.alternatives ?? []).filter((a) => info.has(a.id)).map((a) => ({ id: a.id, name: info.get(a.id)!.name })),
      reason: best?.id ? best.reason : "new",
    };
  });
  review.sort((a, b) => b.campers - a.campers || a.name.localeCompare(b.name));

  const schools = new Map<string, ResolvedSchool>();
  const notSchools: ResolvedSpelling[] = [];
  const bySpelling = new Map<string, SchoolForReports | null>();
  for (const r of resolved.values()) {
    if (r.status === "not-a-school" || r.status === "no-school") {
      notSchools.push(r);
      bySpelling.set(r.entered, null);
    } else if (r.status === "confirmed" || r.status === "auto") {
      const i = info.get(r.schoolId!)!;
      const s = schools.get(i.id) ?? { ...i, campers: 0, spellings: [] };
      s.campers += r.campers;
      s.spellings.push(r);
      schools.set(i.id, s);
      bySpelling.set(r.entered, { name: i.name, type: i.type, state: i.state, county: i.county });
    }
  }
  // Until it's settled, a review item shows in reports under its most common spelling.
  for (const item of review) for (const r of item.spellings) bySpelling.set(r.entered, { name: item.name, type: null, state: null, county: null });
  // Added schools with no spellings yet still appear, so they can be chosen.
  for (const [id, i] of info) if (i.source === "custom" && !schools.has(id)) schools.set(id, { ...i, campers: 0, spellings: [] });

  return {
    schools: [...schools.values()].sort((a, b) => b.campers - a.campers || a.name.localeCompare(b.name)),
    review,
    notSchools: notSchools.sort((a, b) => b.campers - a.campers),
    bySpelling,
  };
}

/** How alike spellings must be to share a review item (both ways round: "Potomac" fits in "Potomac Glen Day", not the reverse). */
const GROUP = 0.85;

/**
 * Spellings that look like each other, most common first. Each group is led
 * by its most common spelling, and a spelling joins a group only when it and
 * the leader match each other both ways round, so short names ("Potomac",
 * "Key") can't chain different schools together.
 */
function groupLookAlikes(spellings: SchoolSpelling[], weights: WordWeights): SchoolSpelling[][] {
  const matcher = new SchoolMatcher(spellings.map((s) => ({ id: s.entered, name: s.entered, campers: s.campers })), weights, true);
  const parsed = new Map(spellings.map((s) => [s.entered, parseSchool(s.entered)]));
  const groups = new Map<string, SchoolSpelling[]>();
  for (const s of spellings) {
    const p = parsed.get(s.entered);
    let leader: string | null = null;
    let best = 0;
    // An answer naming two schools ("Wood Acres / Little Flower") is settled on its own.
    if (p && !p.multi) {
      for (const c of matcher.scores(s.entered)) {
        if (c.score < GROUP || !groups.has(c.id)) continue;
        const l = parsed.get(c.id)!;
        // "The Potomac School" and "Potomac Elementary" are different schools.
        if ((p.named && l.level) || (p.level && l.named)) continue;
        const both = Math.min(c.score, nameScore(l, p, weights, true));
        if (both >= GROUP && both > best) [leader, best] = [c.id, both];
      }
    }
    if (leader) groups.get(leader)!.push(s);
    else groups.set(s.entered, [s]);
  }
  return [...groups.values()];
}
