import { z } from "zod";
import { BUSINESS_LINES_WITH_UNASSIGNED, type BusinessLineOrUnassigned } from "./businessLines.js";

/**
 * A season's tuition and payments from Campminder's Financial report, for
 * one business line (or all). Amounts in USD, positive.
 */
export const campminderFinanceQuerySchema = z.object({
  season: z.coerce.number().int().min(2000).max(2100),
  businessLine: z.enum(BUSINESS_LINES_WITH_UNASSIGNED).optional(),
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
}
