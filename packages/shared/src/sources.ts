/**
 * The platforms data comes from. A platform's transactions are split across
 * business lines (see businessLines.ts) by assignment rules, e.g. Square
 * locations or Campminder sessions.
 */
export const SOURCES = [
  "campminder",
  "fareharbor",
  "hubspot",
  "shopify",
  "square",
] as const;

export type Source = (typeof SOURCES)[number];

export interface SourceInfo {
  id: Source;
  label: string;
  /** How data arrives, shown on the status page. */
  ingestion: string;
  /** Build phase in docs/PLAN.md that connects this platform. */
  phase: number;
}

export const SOURCE_INFO: Record<Source, SourceInfo> = {
  shopify: {
    id: "shopify",
    label: "Shopify",
    ingestion: "Webhooks + 15-min reconciliation",
    phase: 2,
  },
  square: {
    id: "square",
    label: "Square",
    ingestion: "Webhooks + 15-min reconciliation",
    phase: 2,
  },
  hubspot: {
    id: "hubspot",
    label: "HubSpot",
    ingestion: "Webhooks + 15-min reconciliation",
    phase: 3,
  },
  campminder: {
    id: "campminder",
    label: "Campminder",
    ingestion: "Report export automation → Cloud Storage",
    phase: 4,
  },
  fareharbor: {
    id: "fareharbor",
    label: "FareHarbor",
    ingestion: "Booking notification emails (Gmail)",
    phase: 5,
  },
};

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}
