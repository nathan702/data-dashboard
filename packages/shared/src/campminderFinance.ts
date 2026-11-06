import { z } from "zod";
import { BUSINESS_LINES_WITH_UNASSIGNED, type BusinessLineOrUnassigned } from "./businessLines.js";
import { enrollmentFiltersSchema } from "./campminder.js";
import { jsonQueryParam } from "./params.js";

/**
 * A season's tuition and payments from Campminder's Financial report, for
 * one business line (or all). Amounts in USD, positive.
 */
export const campminderFinanceQuerySchema = z.object({
  season: z.coerce.number().int().min(2000).max(2100),
  businessLine: z.enum(BUSINESS_LINES_WITH_UNASSIGNED).optional(),
  /**
   * The Camp page's drill-down filters. With any, only lines for matching
   * camper-sessions count: a session's own charges, discounts and payments,
   * found through the camper's enrollment in that session.
   */
  filters: jsonQueryParam(enrollmentFiltersSchema),
});
export type CampminderFinanceQuery = z.infer<typeof campminderFinanceQuerySchema>;

export interface CampminderFinanceSummary {
  season: number;
  businessLine: BusinessLineOrUnassigned | null;
  /** Charges (debits). */
  charges: number;
  /** Discounts, aid and other credits. */
  discounts: number;
  /** Charges minus discounts. */
  netTuition: number;
  payments: number;
  refunds: number;
  /** Payments minus refunds. */
  netCollected: number;
  /** What households with a balance still owe (their whole season, every line). */
  balanceOwed: number;
  householdsOwing: number;
  /** Credit held for households that have paid more than they owe. */
  creditHeld: number;
  households: number;
  /** Filters applied: only lines tied to a matching camper-session (no unsplit payments, refunds or household fees). */
  filtered: boolean;
}
