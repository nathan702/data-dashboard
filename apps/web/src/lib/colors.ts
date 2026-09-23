import type { BusinessLine } from "@dash/shared";

/**
 * Each business line owns one categorical slot for good, so its color never
 * changes when filters hide other lines. Values live in styles.css
 * (--series-1..5) with separate light and dark steps.
 */
export const LINE_COLOR_VAR: Record<BusinessLine, string> = {
  campminder: "var(--series-1)",
  fareharbor: "var(--series-2)",
  hubspot: "var(--series-3)",
  shopify: "var(--series-4)",
  square: "var(--series-5)",
};
