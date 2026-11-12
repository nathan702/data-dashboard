import { z } from "zod";
import { BUSINESS_LINES, type BusinessLine } from "./businessLines.js";

/** HubSpot deals for one business line: the open pipeline by stage, and won deals by month. */
export const hubspotDealsQuerySchema = z.object({ businessLine: z.enum(BUSINESS_LINES) });
export type HubspotDealsQuery = z.infer<typeof hubspotDealsQuerySchema>;

export interface HubspotStageRow {
  pipeline: string;
  stage: string;
  stageOrder: number | null;
  deals: number;
  amount: number;
}

export interface HubspotMonthRow {
  /** First day of the month the deals closed (won). */
  month: string;
  deals: number;
  amount: number;
}

export interface HubspotDealsResponse {
  businessLine: BusinessLine;
  /** Open deals (not closed), by pipeline and stage. */
  open: HubspotStageRow[];
  /** Won deals by close month, the last 24 months. */
  won: HubspotMonthRow[];
}

// ---------- Programs (won deals by program date) ----------

/** What each reported HubSpot deal property means. */
export const HUBSPOT_ROLES = ["participants", "chaperones", "programType", "food", "transportation"] as const;
export type HubspotRole = (typeof HUBSPOT_ROLES)[number];
export const HUBSPOT_ROLE_LABEL: Record<HubspotRole, string> = {
  participants: "Participants",
  chaperones: "Chaperones",
  programType: "Program type",
  food: "Uses our food",
  transportation: "Uses our transportation",
};
/** Numbers for counts; choices (dropdown, yes/no) for the others. */
export const HUBSPOT_ROLE_KIND: Record<HubspotRole, "number" | "choice"> = {
  participants: "number",
  chaperones: "number",
  programType: "choice",
  food: "choice",
  transportation: "choice",
};
const ROLE_GUESS: Record<HubspotRole, RegExp> = {
  participants: /participant|student|attendee|camper|guest|headcount|kids|children/i,
  chaperones: /chaperone|adult|teacher count/i,
  programType: /program\s*type|type of program/i,
  food: /food|lunch|meal|catering/i,
  transportation: /transport|bus/i,
};

export interface HubspotProperty {
  name: string;
  label: string;
  type: string;
  options: Array<{ value: string; label: string }>;
}

/**
 * Settings → HubSpot: which deal properties play each role (empty = guess from
 * labels). Counts (participants, chaperones) can add up several properties,
 * e.g. free + paid chaperones; a choice role uses one.
 */
export type HubspotSettings = Record<HubspotRole, string[]>;
export const DEFAULT_HUBSPOT_SETTINGS: HubspotSettings = { participants: [], chaperones: [], programType: [], food: [], transportation: [] };
const propertyName = z.string().regex(/^[a-z0-9_]{1,100}$/i);
// Older settings stored one name (or null) per role.
const roleValue = z.preprocess((v) => (typeof v === "string" ? [v] : v === null || v === undefined ? [] : v), z.array(propertyName).max(10));
export const hubspotSettingsSchema = z.object(Object.fromEntries(HUBSPOT_ROLES.map((r) => [r, roleValue])) as Record<HubspotRole, typeof roleValue>);

const fits = (role: HubspotRole, p: HubspotProperty) =>
  HUBSPOT_ROLE_KIND[role] === "number" ? p.type === "number" : p.type === "enumeration" || p.type === "bool";
/** Roles where every property whose label fits is added up when guessing (free + paid chaperones). */
const GUESS_ALL: HubspotRole[] = ["chaperones"];

/**
 * The properties for each role: the ones set on Settings (that still exist),
 * else those whose label fits: all of them for chaperones, the first for the
 * others. A choice role only ever uses its first property.
 */
export function resolveHubspotRoles(settings: HubspotSettings, properties: HubspotProperty[]): Record<HubspotRole, string[]> {
  const out = {} as Record<HubspotRole, string[]>;
  const known = new Set(properties.map((p) => p.name));
  for (const role of HUBSPOT_ROLES) {
    const set = (settings[role] ?? []).filter((n) => known.has(n));
    if (set.length) {
      out[role] = HUBSPOT_ROLE_KIND[role] === "choice" ? set.slice(0, 1) : set;
      continue;
    }
    const guesses = properties.filter((p) => fits(role, p) && (ROLE_GUESS[role].test(p.label) || ROLE_GUESS[role].test(p.name))).map((p) => p.name);
    out[role] = GUESS_ALL.includes(role) ? guesses : guesses.slice(0, 1);
  }
  return out;
}

/** A yes/no or dropdown value that means "yes" (for food and transportation uptake). */
export const isYes = (v: string | null) => !!v && /^(true|yes|y|1)$/i.test(v.trim());

export const hubspotProgramsQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES),
  season: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type HubspotProgramsQuery = z.infer<typeof hubspotProgramsQuerySchema>;

/**
 * Won deals grouped by period ("current" season, "previous" season), whether
 * last season's deal was won by the same point a year ago, program month and
 * the choice-property values. Counts are summed; programs with a count
 * property filled in are counted separately, for averages.
 */
export interface HubspotProgramRow {
  period: "current" | "previous";
  /** Previous-season deals won on or before the same point last year. */
  atSamePoint: boolean;
  /** First day of the program month. */
  month: string;
  programType: string | null;
  food: string | null;
  transportation: string | null;
  deals: number;
  revenue: number;
  participants: number;
  dealsWithParticipants: number;
  chaperones: number;
  dealsWithChaperones: number;
}

export interface HubspotLineItemRow {
  period: "current" | "previous";
  atSamePoint: boolean;
  item: string;
  quantity: number;
  amount: number;
  deals: number;
}

export interface HubspotProgramsResponse {
  businessLine: BusinessLine;
  season: number;
  seasons: number[];
  current: { start: string; end: string };
  previous: { start: string; end: string };
  /** Last season's deals count "at the same point" when won (closed) on or before this day. */
  samePointCutoff: string;
  /** The properties used for each role (none when nothing fits), with labels and choices; counts add them up. */
  roles: Record<HubspotRole, HubspotProperty[]>;
  programs: HubspotProgramRow[];
  lineItems: HubspotLineItemRow[];
}
