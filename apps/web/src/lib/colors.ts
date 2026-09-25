import type { Source } from "@dash/shared";

/**
 * Each platform owns one categorical slot for good (used on the Advanced
 * pages that compare platforms), so its color never changes when filters hide
 * others. Values live in styles.css (--series-1..5) with light and dark steps.
 */
export const SOURCE_COLOR_VAR: Record<Source, string> = {
  campminder: "var(--series-1)",
  fareharbor: "var(--series-2)",
  hubspot: "var(--series-3)",
  shopify: "var(--series-4)",
  square: "var(--series-5)",
};

/** Single-series charts (one business line, or a total) use the accent. */
export const ACCENT_VAR = "var(--accent)";
