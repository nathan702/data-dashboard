import type { Source } from "./sources.js";

/**
 * The organization's business lines, in default tab order. Each is fed by one
 * or more platforms; which transactions belong where is decided by the
 * assignment rules managed on the Settings page (see assignments.ts).
 */
export const BUSINESS_LINES = [
  "camp",
  "river_school",
  "events",
  "haunted_forest",
  "chaps",
  "education",
  "school_year",
  "river_store",
  "farm_store",
] as const;

export type BusinessLine = (typeof BUSINESS_LINES)[number];

/** Transactions no rule assigns yet. Shown so nothing silently drops out. */
export const UNASSIGNED = "unassigned" as const;
export type BusinessLineOrUnassigned = BusinessLine | typeof UNASSIGNED;
export const BUSINESS_LINES_WITH_UNASSIGNED = [...BUSINESS_LINES, UNASSIGNED] as const;

export interface BusinessLineInfo {
  id: BusinessLine;
  label: string;
  /** Platforms that feed this line, in the order their sections appear. */
  sources: Source[];
  /** What each platform contributes, shown as its section title. */
  sourceRoles: Partial<Record<Source, string>>;
}

export const BUSINESS_LINE_INFO: Record<BusinessLine, BusinessLineInfo> = {
  camp: { id: "camp", label: "Camp", sources: ["campminder"], sourceRoles: { campminder: "Enrollment" } },
  river_school: { id: "river_school", label: "River School", sources: ["fareharbor"], sourceRoles: { fareharbor: "Bookings" } },
  events: {
    id: "events",
    label: "Events",
    sources: ["fareharbor", "square"],
    sourceRoles: { fareharbor: "Bookings", square: "On-site food & beverage" },
  },
  haunted_forest: {
    id: "haunted_forest",
    label: "Haunted Forest",
    sources: ["fareharbor", "square"],
    sourceRoles: { fareharbor: "Bookings", square: "On-site food & beverage" },
  },
  chaps: {
    id: "chaps",
    label: "CHAPs",
    sources: ["campminder", "hubspot"],
    sourceRoles: { campminder: "Individual programs", hubspot: "Group bookings & parties" },
  },
  education: { id: "education", label: "Education Programs", sources: ["hubspot"], sourceRoles: { hubspot: "Deals" } },
  school_year: { id: "school_year", label: "School Year Programs", sources: ["campminder"], sourceRoles: { campminder: "Enrollment" } },
  river_store: { id: "river_store", label: "River Store", sources: ["shopify"], sourceRoles: { shopify: "Sales" } },
  farm_store: { id: "farm_store", label: "Farm Store", sources: ["square"], sourceRoles: { square: "Sales" } },
};

export const UNASSIGNED_LABEL = "Unassigned";

export function isBusinessLine(v: string): v is BusinessLine {
  return (BUSINESS_LINES as readonly string[]).includes(v);
}

export function isBusinessLineOrUnassigned(v: string): v is BusinessLineOrUnassigned {
  return v === UNASSIGNED || isBusinessLine(v);
}

export function businessLineLabel(v: BusinessLineOrUnassigned): string {
  return v === UNASSIGNED ? UNASSIGNED_LABEL : BUSINESS_LINE_INFO[v].label;
}
