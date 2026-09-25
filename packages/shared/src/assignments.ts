import { z } from "zod";
import { BUSINESS_LINES_WITH_UNASSIGNED, type BusinessLineOrUnassigned } from "./businessLines.js";
import { SOURCES, type Source } from "./sources.js";

/**
 * What a platform's transactions are split by. One value per source for now;
 * e.g. every Square location is assigned to exactly one business line.
 */
export const ASSIGNMENT_KINDS: Record<Source, { kind: string; label: string }> = {
  square: { kind: "location", label: "Location" },
  shopify: { kind: "store", label: "Store" },
  fareharbor: { kind: "company", label: "FareHarbor dashboard" },
  campminder: { kind: "session", label: "Session" },
  hubspot: { kind: "pipeline", label: "Pipeline" },
};

/** One assignable value (e.g. the "MHF" Square location) and where it goes now. */
export interface AssignmentRow {
  source: Source;
  kind: string;
  key: string;
  label: string;
  businessLine: BusinessLineOrUnassigned;
  /** "explicit" = saved on the Settings page; "default" = built-in suggestion; "none" = unassigned. */
  origin: "explicit" | "default" | "none";
  lastActivity: string | null;
  /** Net sales over the last 12 months, to help spot what matters. */
  netLast12Months: number;
}

export interface AssignmentsResponse {
  rows: AssignmentRow[];
  canEdit: boolean;
  /** When saved changes will show on dashboards. */
  pendingRefresh: boolean;
}

export const assignmentUpdateSchema = z.object({
  changes: z
    .array(
      z.object({
        source: z.enum(SOURCES),
        kind: z.string().min(1).max(40),
        key: z.string().min(1).max(200),
        businessLine: z.enum(BUSINESS_LINES_WITH_UNASSIGNED),
      }),
    )
    .min(1)
    .max(500),
});
export type AssignmentUpdate = z.infer<typeof assignmentUpdateSchema>;
