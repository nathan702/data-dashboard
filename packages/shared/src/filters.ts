import { z } from "zod";
import { BUSINESS_LINES } from "./businessLines.js";
import { daysBetweenInclusive, isIsoDate } from "./dates.js";

/**
 * Which date a dollar is counted on:
 * - booked: when the order/booking/enrollment/deal close happened
 * - collected: when money was actually received
 * - service: when the activity/session takes place (FareHarbor, Campminder)
 */
export const REVENUE_BASES = ["booked", "collected", "service"] as const;
export type RevenueBasis = (typeof REVENUE_BASES)[number];

/**
 * gross: before discounts and refunds
 * net: gross - discounts - refunds
 * net_after_fees: net - processing/platform fees
 */
export const REVENUE_MEASURES = ["gross", "net", "net_after_fees"] as const;
export type RevenueMeasure = (typeof REVENUE_MEASURES)[number];

export const GRANULARITIES = ["day", "week", "month", "season"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

const isoDate = z.string().refine(isIsoDate, "Expected a YYYY-MM-DD date");

/** Longest range a single request may ask for (about 30 years of history). */
export const MAX_RANGE_DAYS = 366 * 30;

export const revenueQuerySchema = z
  .object({
    start: isoDate,
    end: isoDate,
    basis: z.enum(REVENUE_BASES).default("booked"),
    measure: z.enum(REVENUE_MEASURES).default("net"),
    granularity: z.enum(GRANULARITIES).default("day"),
    compare: z.enum(["none", "previous_period", "previous_year"]).default("previous_year"),
    businessLines: z.array(z.enum(BUSINESS_LINES)).optional(),
  })
  .refine((q) => q.start <= q.end, { message: "start must be on or before end", path: ["start"] })
  .refine((q) => daysBetweenInclusive(q.start, q.end) <= MAX_RANGE_DAYS, {
    message: "Date range is too long",
    path: ["end"],
  });

export type RevenueQuery = z.infer<typeof revenueQuerySchema>;
