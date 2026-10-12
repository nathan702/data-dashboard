import { z } from "zod";
import { BUSINESS_LINES_WITH_UNASSIGNED, type BusinessLineOrUnassigned } from "./businessLines.js";
import { COMPARISON_MODES, daysBetweenInclusive, isIsoDate } from "./dates.js";
import { MAX_RANGE_DAYS } from "./filters.js";
import { jsonQueryParam } from "./params.js";

/** Platforms backed by marts.fct_retail_orders / fct_retail_line_items. */
export const RETAIL_SOURCES = ["shopify", "square"] as const;
export type RetailSource = (typeof RETAIL_SOURCES)[number];

export function isRetailSource(v: string): v is RetailSource {
  return (RETAIL_SOURCES as readonly string[]).includes(v);
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

export const RETAIL_SOURCE_DIMENSIONS: Record<RetailSource, RetailDimension[]> = {
  // Shopify "category" is the product type; location is the POS location (online orders have none).
  // Category first: the natural drill-down is category → item → variant.
  shopify: ["category", "item", "variant", "channel", "location"],
  square: ["category", "item", "variant", "location", "channel"],
};

/** Drill-down filters: dimension → values; a sale counts when it matches every filtered dimension. */
export type RetailFilters = Partial<Record<RetailDimension, string[]>>;
export const retailFiltersSchema = z.partialRecord(z.enum(RETAIL_DIMENSIONS), z.array(z.string().max(300)).max(100));
const filters = jsonQueryParam(retailFiltersSchema);

export const hasFilters = (f: Record<string, string[] | undefined> | undefined) => Object.values(f ?? {}).some((v) => v && v.length > 0);

const isoDate = z.string().refine(isIsoDate, "Expected a YYYY-MM-DD date");

/** Limit to one business line's share of the platform (e.g. Square sales for Events). */
const businessLine = z.enum(BUSINESS_LINES_WITH_UNASSIGNED).optional();

const rangeFields = {
  start: isoDate,
  end: isoDate,
  compare: z.enum(COMPARISON_MODES).default("previous_year"),
  businessLine,
  filters,
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
    businessLine,
    filters,
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
  source: RetailSource;
  businessLine: BusinessLineOrUnassigned | null;
  range: { start: string; end: string };
  comparisonRange: { start: string; end: string } | null;
  current: RetailKpis;
  comparison: RetailKpis | null;
  /**
   * Drill-down filters applied: figures come from the matching line items, so
   * order-wide amounts (refunds, tax, tips, fees, customers) are left at 0.
   */
  filtered: boolean;
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
  source: RetailSource;
  businessLine: BusinessLineOrUnassigned | null;
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
