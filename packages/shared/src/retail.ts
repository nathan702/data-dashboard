import { z } from "zod";
import { daysBetweenInclusive, isIsoDate } from "./dates.js";
import { MAX_RANGE_DAYS } from "./filters.js";

/** Business lines backed by marts.fct_retail_orders / fct_retail_line_items. */
export const RETAIL_LINES = ["shopify", "square"] as const;
export type RetailLine = (typeof RETAIL_LINES)[number];

export function isRetailLine(v: string): v is RetailLine {
  return (RETAIL_LINES as readonly string[]).includes(v);
}

/** Ways to slice line-item sales. Not every line has every dimension. */
export const RETAIL_DIMENSIONS = ["item", "variant", "category", "location", "channel"] as const;
export type RetailDimension = (typeof RETAIL_DIMENSIONS)[number];

export const RETAIL_DIMENSION_LABEL: Record<RetailDimension, string> = {
  item: "Item",
  variant: "Item & variant",
  category: "Category",
  location: "Location",
  channel: "Channel",
};

export const RETAIL_LINE_DIMENSIONS: Record<RetailLine, RetailDimension[]> = {
  // Shopify "category" is the product type; location is the POS location (online orders have none).
  shopify: ["item", "variant", "category", "channel", "location"],
  square: ["item", "variant", "category", "location", "channel"],
};

const isoDate = z.string().refine(isIsoDate, "Expected a YYYY-MM-DD date");

const rangeFields = {
  start: isoDate,
  end: isoDate,
  compare: z.enum(["none", "previous_period", "previous_year"]).default("previous_year"),
};

const validRange = <T extends { start: string; end: string }>(q: T) =>
  q.start <= q.end && daysBetweenInclusive(q.start, q.end) <= MAX_RANGE_DAYS;

export const retailKpiQuerySchema = z.object(rangeFields).refine(validRange, "Invalid date range");
export type RetailKpiQuery = z.infer<typeof retailKpiQuerySchema>;

export const retailBreakdownQuerySchema = z
  .object({
    start: isoDate,
    end: isoDate,
    dimension: z.enum(RETAIL_DIMENSIONS).default("item"),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .refine(validRange, "Invalid date range");
export type RetailBreakdownQuery = z.infer<typeof retailBreakdownQuerySchema>;

export interface RetailKpis {
  orders: number;
  units: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  tax: number;
  tips: number;
  fees: number;
  /** Net sales per order. */
  averageOrderValue: number;
  customers: number;
}

export interface RetailKpiResponse {
  line: RetailLine;
  range: { start: string; end: string };
  comparisonRange: { start: string; end: string } | null;
  current: RetailKpis;
  comparison: RetailKpis | null;
}

export interface RetailBreakdownRow {
  /** Display label, e.g. item name, "Item — Variant", location name. */
  key: string;
  /** Secondary label where useful (SKU for variants, category for items). */
  detail: string | null;
  orders: number;
  units: number;
  gross: number;
  discounts: number;
  net: number;
}

export interface RetailBreakdownResponse {
  line: RetailLine;
  dimension: RetailDimension;
  range: { start: string; end: string };
  rows: RetailBreakdownRow[];
  /** True when more rows exist than were returned. */
  truncated: boolean;
}

export interface InventoryRow {
  product: string;
  variant: string | null;
  sku: string | null;
  location: string;
  available: number;
  onHand: number;
}

export interface InventoryResponse {
  snapshotAt: string | null;
  rows: InventoryRow[];
}
