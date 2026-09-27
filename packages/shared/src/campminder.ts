import { z } from "zod";
import { BUSINESS_LINES_WITH_UNASSIGNED, type BusinessLineOrUnassigned } from "./businessLines.js";

/** Ways to slice Campminder enrollments. */
export const ENROLLMENT_DIMENSIONS = ["session_group", "session", "program", "week", "age", "grade", "gender", "years", "state", "status"] as const;
export type EnrollmentDimension = (typeof ENROLLMENT_DIMENSIONS)[number];

export const ENROLLMENT_DIMENSION_LABEL: Record<EnrollmentDimension, string> = {
  session_group: "Session group",
  session: "Session",
  program: "Program",
  week: "Week",
  age: "Age",
  grade: "School grade",
  gender: "Gender",
  years: "Years at camp",
  state: "Home state",
  status: "Status",
};

const season = z.coerce.number().int().min(2000).max(2100);
const businessLine = z.enum(BUSINESS_LINES_WITH_UNASSIGNED).optional();

export const enrollmentSeasonsQuerySchema = z.object({ businessLine });
export const enrollmentSummaryQuerySchema = z.object({ season, businessLine });
export const enrollmentBreakdownQuerySchema = z.object({
  season,
  businessLine,
  dimension: z.enum(ENROLLMENT_DIMENSIONS).default("session_group"),
});
export type EnrollmentSummaryQuery = z.infer<typeof enrollmentSummaryQuerySchema>;
export type EnrollmentBreakdownQuery = z.infer<typeof enrollmentBreakdownQuerySchema>;

export interface EnrollmentSeason {
  season: number;
  enrollments: number;
}

export interface EnrollmentKpis {
  /** Distinct campers with at least one enrolled session. */
  campers: number;
  /** Enrolled camper-sessions. */
  enrollments: number;
  /** Campers in their first year at camp. */
  newCampers: number;
  returningCampers: number;
  cancelled: number;
  withdrawn: number;
  waitlisted: number;
}

export interface EnrollmentSummaryResponse {
  season: number;
  businessLine: BusinessLineOrUnassigned | null;
  current: EnrollmentKpis;
  /**
   * Last season at the same point: its enrollments applied for by the same
   * day of the season (the whole season once this one is over).
   */
  comparison: EnrollmentKpis | null;
  /** Enrolled campers attending each week (multi-week sessions count in every week). */
  byWeek: Array<{ week: number; enrollments: number }>;
  /** Cumulative enrollments by week of the season (by application date). */
  pace: Array<{ weekOfSeason: number; current: number | null; previous: number | null }>;
  asOf: string;
}

export interface EnrollmentBreakdownRow {
  key: string;
  campers: number;
  enrollments: number;
  cancelled: number;
  withdrawn: number;
  waitlisted: number;
}

export interface EnrollmentBreakdownResponse {
  season: number;
  businessLine: BusinessLineOrUnassigned | null;
  dimension: EnrollmentDimension;
  rows: EnrollmentBreakdownRow[];
}

/** Natural order for grades ("Pre-K" < "K" < "1st" … "12th+"). */
export function gradeOrder(g: string): number {
  const t = g.trim().toLowerCase();
  if (t === "nursery") return -3;
  if (t === "pre-k") return -2;
  if (t === "k") return -1;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n + (t.endsWith("+") ? 0.5 : 0) : 99;
}
