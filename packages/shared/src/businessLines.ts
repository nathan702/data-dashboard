/**
 * Each revenue platform maps to one business line. Reporting is kept separate
 * per line; the only cross-line view is the summary page built on
 * marts.fct_revenue_daily.
 */
export const BUSINESS_LINES = [
  "campminder",
  "fareharbor",
  "hubspot",
  "shopify",
  "square",
] as const;

export type BusinessLine = (typeof BUSINESS_LINES)[number];

export interface BusinessLineInfo {
  id: BusinessLine;
  label: string;
  /** How data arrives, shown on the status page. */
  ingestion: string;
  /** Build phase in docs/PLAN.md that delivers this line. */
  phase: number;
}

export const BUSINESS_LINE_INFO: Record<BusinessLine, BusinessLineInfo> = {
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

export function isBusinessLine(value: string): value is BusinessLine {
  return (BUSINESS_LINES as readonly string[]).includes(value);
}
