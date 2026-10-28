import { z } from "zod";
import { gradeOrder } from "./campminder.js";
import { isIsoDate } from "./dates.js";

/**
 * Report builder: the data sets, fields and measures people can combine.
 * Everything a report can ask for is listed here (with the SQL in the API's
 * reportSql.ts), so reports can't express anything unvetted and the same
 * word always means the same thing.
 */

export const REPORT_DATASETS = ["enrollments", "camper_seasons", "program_families", "revenue", "store_sales"] as const;
export type ReportDataset = (typeof REPORT_DATASETS)[number];

/** How a field's values sort: numbers, school grades, weekdays, or text. */
export type FieldOrder = "numeric" | "grade" | "weekday" | "text";
export type MeasureFormat = "count" | "money" | "decimal" | "percent";

export interface ReportField {
  id: string;
  label: string;
  description: string;
  order: FieldOrder;
}

export interface ReportMeasure {
  id: string;
  label: string;
  description: string;
  format: MeasureFormat;
  /** Can be shown as a share of row/column/total (counts and sums only). */
  additive: boolean;
}

export interface ReportDatasetInfo {
  id: ReportDataset;
  label: string;
  description: string;
  /** Needs a date range (revenue and store sales); the others filter by season. */
  dated: boolean;
  fields: ReportField[];
  measures: ReportMeasure[];
  defaultMeasure: string;
}

const f = (id: string, label: string, description: string, order: FieldOrder = "text"): ReportField => ({ id, label, description, order });
const m = (id: string, label: string, description: string, format: MeasureFormat, additive: boolean): ReportMeasure => ({
  id,
  label,
  description,
  format,
  additive,
});

/** Camper attributes shared by the Campminder data sets. */
const CAMPER_FIELDS = [
  f("season", "Season", "Campminder season (named by the summer it ends in).", "numeric"),
  f("business_line", "Business line", "Camp, CHAPs, School Year Programs… (from the session group's assignment)."),
  f("camper", "Camper", "One camper (scrambled ID, the same across seasons). Group by this to list individual campers."),
  f("years_at_camp", "Years at camp", "Campminder's years as a camper, as of that season (1 = first year).", "numeric"),
  f("new_or_returning", "New or returning", "New = first year at camp that season."),
  f("age", "Age", "Age on June 1 of the season.", "numeric"),
  f("grade", "School grade", "School grade that season.", "grade"),
  f("school", "School", "School that season, with spellings grouped (Settings → Schools)."),
  f("school_as_entered", "School as entered", "School exactly as the family typed it."),
  f("gender", "Gender", "As recorded in Campminder."),
  f("state", "Home state", "Primary household's state."),
  f("zip", "Home ZIP", "Primary household's 5-digit ZIP code."),
];

export const REPORT_DATASET_INFO: Record<ReportDataset, ReportDatasetInfo> = {
  enrollments: {
    id: "enrollments",
    label: "Enrollments",
    description: "One row per camper per session (any status). Measures count enrolled sessions unless they say otherwise.",
    dated: false,
    defaultMeasure: "enrollments",
    fields: [
      ...CAMPER_FIELDS,
      f("session_group", "Session group", "Session name without the week (“Farm Week 9” → “Farm”)."),
      f("session", "Session", "Full session name."),
      f("program", "Program", "The program within the session (e.g. a branch of Explorers)."),
      f("program_family", "Program family", "Programs grouped into families (Settings → Program families)."),
      f("program_branch", "Program branch", "The branch within its family."),
      f("week", "Week", "Week of summer camp. A multi-week session counts in each of its weeks.", "numeric"),
      f("status", "Status", "Enrolled, Cancelled, Withdrawn, Waitlisted…"),
    ],
    measures: [
      m("enrollments", "Enrollments", "Enrolled camper-sessions.", "count", true),
      m("campers", "Campers", "Distinct campers with an enrolled session (each counted once).", "count", true),
      m("families", "Families", "Distinct households with an enrolled camper.", "count", true),
      m("registrations", "Registrations (any status)", "Camper-sessions of every status, including cancelled and waitlisted.", "count", true),
      m("cancelled", "Cancelled", "Camper-sessions cancelled.", "count", true),
      m("withdrawn", "Withdrawn", "Camper-sessions withdrawn.", "count", true),
      m("waitlisted", "Waitlisted", "Camper-sessions on a waitlist.", "count", true),
    ],
  },
  camper_seasons: {
    id: "camper_seasons",
    label: "Campers by season",
    description: "One row per camper per season and business line, built from their enrolled sessions.",
    dated: false,
    defaultMeasure: "campers",
    fields: [
      ...CAMPER_FIELDS,
      f("sessions", "Sessions that season", "Number of enrolled sessions.", "numeric"),
      f("weeks", "Weeks that season", "Weeks of weekly sessions enrolled.", "numeric"),
      f("first_week", "First week", "Earliest week attended that summer.", "numeric"),
      f("last_week", "Last week", "Latest week attended that summer.", "numeric"),
      f("programs", "Programs that season", "Number of different programs.", "numeric"),
      f("returned", "Came back next season", "Returned / Didn't return / Not known yet (the next season hasn't happened)."),
    ],
    measures: [
      m("campers", "Campers", "Distinct campers.", "count", true),
      m("avg_sessions", "Average sessions per camper", "Mean enrolled sessions per camper that season.", "decimal", false),
      m("avg_weeks", "Average weeks per camper", "Mean weeks enrolled per camper that season.", "decimal", false),
      m("return_rate", "% who came back", "Share of campers enrolled again the next season (seasons with a known next season only).", "percent", false),
      m("sessions_total", "Sessions", "Total enrolled sessions.", "count", true),
      m("families", "Families", "Distinct households.", "count", true),
    ],
  },
  program_families: {
    id: "program_families",
    label: "Campers by program family",
    description: "One row per camper per season per program family, with which branches of the family they did.",
    dated: false,
    defaultMeasure: "campers",
    fields: [
      ...CAMPER_FIELDS,
      f("program_family", "Program family", "Programs grouped into families (Settings → Program families)."),
      f("branches", "Branches done", "How many different branches of the family the camper did that season.", "numeric"),
      f("branch_combination", "Branch combination", "Which branches, e.g. “Great Heights + Quest”."),
    ],
    measures: [
      m("campers", "Campers", "Distinct campers.", "count", true),
      m("avg_branches", "Average branches per camper", "Mean number of branches done.", "decimal", false),
    ],
  },
  revenue: {
    id: "revenue",
    label: "Revenue",
    description: "Daily revenue for every business line and platform, by program/service date unless filtered to another date basis.",
    dated: true,
    defaultMeasure: "net",
    fields: [
      f("business_line", "Business line", "Which business line the revenue counts toward."),
      f("source", "Platform", "Square, Shopify, FareHarbor…"),
      f("year", "Year", "Calendar year.", "numeric"),
      f("month", "Month", "Calendar month (YYYY-MM).", "numeric"),
      f("weekday", "Weekday", "Day of the week.", "weekday"),
      f("date", "Date", "Day (YYYY-MM-DD).", "numeric"),
      f("date_basis", "Date basis", "Program/service date (default), date booked, or date paid. Filter to one."),
    ],
    measures: [
      m("net", "Net revenue", "Gross minus discounts and refunds.", "money", true),
      m("gross", "Gross revenue", "Before discounts and refunds.", "money", true),
      m("net_after_fees", "Net after fees", "Net minus processing fees.", "money", true),
      m("transactions", "Transactions", "Orders, bookings or payments.", "count", true),
    ],
  },
  store_sales: {
    id: "store_sales",
    label: "Store sales",
    description: "Square and Shopify sales, one row per item sold.",
    dated: true,
    defaultMeasure: "net",
    fields: [
      f("source", "Platform", "Square or Shopify."),
      f("business_line", "Business line", "Farm Store, River Store, Events…"),
      f("location", "Location", "Square location (online orders: “Online store”)."),
      f("channel", "Channel", "Point of Sale, Online Store, Kiosk…"),
      f("category", "Category", "Item category."),
      f("item", "Item", "Item name."),
      f("variant", "Item & variant", "Item with its variant (size, flavor…)."),
      f("year", "Year", "Calendar year.", "numeric"),
      f("month", "Month", "Calendar month (YYYY-MM).", "numeric"),
      f("weekday", "Weekday", "Day of the week.", "weekday"),
      f("date", "Date", "Day (YYYY-MM-DD).", "numeric"),
    ],
    measures: [
      m("net", "Net sales", "Gross minus discounts.", "money", true),
      m("gross", "Gross sales", "Before discounts.", "money", true),
      m("discounts", "Discounts", "Discounts given.", "money", true),
      m("units", "Units sold", "Quantity sold.", "count", true),
      m("orders", "Orders", "Distinct orders containing the items.", "count", true),
    ],
  },
};

export const REPORT_CHARTS = ["table", "bar", "line", "heatmap"] as const;
export type ReportChart = (typeof REPORT_CHARTS)[number];
export const REPORT_PERCENTS = ["none", "row", "column", "total"] as const;
export type ReportPercent = (typeof REPORT_PERCENTS)[number];

const isoDate = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");

export const reportSpecSchema = z
  .object({
    dataset: z.enum(REPORT_DATASETS),
    /** Up to two fields down the side. */
    rows: z.array(z.string()).max(2).default([]),
    /** Optional field across the top. */
    column: z.string().optional(),
    measure: z.string(),
    filters: z.record(z.string(), z.array(z.string().max(300)).max(500)).default({}),
    start: isoDate.optional(),
    end: isoDate.optional(),
    chart: z.enum(REPORT_CHARTS).default("table"),
    percent: z.enum(REPORT_PERCENTS).default("none"),
  })
  .superRefine((s, ctx) => {
    const info = REPORT_DATASET_INFO[s.dataset];
    const fieldIds = new Set(info.fields.map((x) => x.id));
    for (const id of [...s.rows, ...(s.column ? [s.column] : []), ...Object.keys(s.filters)]) {
      if (!fieldIds.has(id)) ctx.addIssue({ code: "custom", message: `Unknown field "${id}" for ${info.label}` });
    }
    if (new Set([...s.rows, s.column].filter(Boolean)).size !== s.rows.length + (s.column ? 1 : 0)) {
      ctx.addIssue({ code: "custom", message: "A field can only be used once across rows and columns" });
    }
    const measure = info.measures.find((x) => x.id === s.measure);
    if (!measure) ctx.addIssue({ code: "custom", message: `Unknown measure "${s.measure}" for ${info.label}` });
    else if (s.percent !== "none" && !measure.additive) ctx.addIssue({ code: "custom", message: `${measure.label} can't be shown as a share` });
    if (info.dated) {
      if (!s.start || !s.end) ctx.addIssue({ code: "custom", message: `${info.label} needs a date range` });
      else if (s.start > s.end) ctx.addIssue({ code: "custom", message: "The date range ends before it starts" });
    }
  });
export type ReportSpec = z.infer<typeof reportSpecSchema>;

/** One line of a report result. `kind` says which totals it is (computed in the database, so distinct counts stay right). */
export interface ReportCell {
  kind: "cell" | "row_total" | "column_total" | "total";
  rows: string[];
  column: string | null;
  value: number | null;
}

export interface ReportResult {
  spec: ReportSpec;
  cells: ReportCell[];
  /** More cells than shown (the limit is 5,000). */
  truncated: boolean;
  generatedAt: string;
}

export const REPORT_CELL_LIMIT = 5000;
export const NONE_VALUE = "(none)";

/** A saved report. Starter reports are built in and can't be edited, only copied. */
export interface SavedReport {
  id: string;
  name: string;
  description: string;
  spec: ReportSpec;
  owner: string | null;
  shared: boolean;
  starter: boolean;
  updatedAt: string | null;
}

export const savedReportInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  shared: z.boolean().default(false),
  spec: reportSpecSchema,
});
export type SavedReportInput = z.infer<typeof savedReportInputSchema>;

/** Values of one field (for the filter picker), with how many records each covers. */
export const reportValuesQuerySchema = z.object({
  spec: reportSpecSchema,
  field: z.string(),
});

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Sort key for a field value, following the field's natural order. */
export function fieldSortKey(order: FieldOrder, v: string): number | string {
  if (v === NONE_VALUE) return order === "text" ? "￿" : Number.MAX_SAFE_INTEGER;
  switch (order) {
    case "numeric": {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    case "weekday":
      return WEEKDAYS.indexOf(v);
    case "grade":
      return gradeOrder(v);
    default:
      return v.toLowerCase();
  }
}

/** Draft program family/branch from a program name: "Explorers - Quest" → Explorers / Quest. Mirrors reportSql.ts. */
export function draftProgramFamily(program: string): { family: string; branch: string | null } {
  const i = program.indexOf(" - ");
  return i > 0 ? { family: program.slice(0, i).trim(), branch: program.slice(i + 3).trim() || null } : { family: program.trim(), branch: null };
}

/** Program → family/branch overrides (Settings); programs not listed use draftProgramFamily. */
export interface ProgramFamilySettings {
  overrides: Record<string, { family: string; branch: string | null }>;
}

export const programFamilySettingsSchema = z.object({
  overrides: z.record(
    z.string().max(300),
    z.object({ family: z.string().trim().min(1).max(200), branch: z.string().trim().max(200).nullable() }),
  ),
});

const starter = (id: string, name: string, description: string, spec: Partial<ReportSpec> & Pick<ReportSpec, "dataset" | "measure">): SavedReport => ({
  id: `starter-${id}`,
  name,
  description,
  spec: reportSpecSchema.parse(spec),
  owner: null,
  shared: true,
  starter: true,
  updatedAt: null,
});

/** Built-in reports for the recurring questions; copy one to change it. */
export const STARTER_REPORTS: SavedReport[] = [
  starter(
    "sessions-by-years",
    "Sessions per camper by years at camp",
    "Do campers sign up for more sessions the longer they've been coming? Average enrolled sessions per camper, by years at camp, per season.",
    { dataset: "camper_seasons", rows: ["years_at_camp"], column: "season", measure: "avg_sessions", filters: { business_line: ["camp"] }, chart: "line" },
  ),
  starter(
    "explorers-branches",
    "Explorers: which branches do campers do?",
    "Of campers in any Explorers branch, the share who did each combination of branches, per season.",
    {
      dataset: "program_families",
      rows: ["branch_combination"],
      column: "season",
      measure: "campers",
      filters: { program_family: ["Explorers"] },
      percent: "column",
      chart: "bar",
    },
  ),
  starter(
    "zip-by-week",
    "When in the summer campers from each ZIP attend",
    "Share of each ZIP's camp enrollments in each week of summer. Filter to one season or ZIP to focus.",
    { dataset: "enrollments", rows: ["zip"], column: "week", measure: "enrollments", filters: { business_line: ["camp"] }, percent: "row", chart: "heatmap" },
  ),
  starter(
    "schools",
    "Which schools campers come from",
    "Campers from each school, per season, with spellings grouped (Settings → Schools). Filter by business line or grade to focus.",
    { dataset: "camper_seasons", rows: ["school"], column: "season", measure: "campers", filters: { business_line: ["camp"] } },
  ),
  starter(
    "retention",
    "Who comes back next season",
    "Share of each season's campers who enrolled again the following season, by years at camp.",
    { dataset: "camper_seasons", rows: ["years_at_camp"], column: "season", measure: "return_rate", filters: { business_line: ["camp"] } },
  ),
];
