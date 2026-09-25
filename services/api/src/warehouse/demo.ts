import {
  addDays,
  comparisonRange,
  seasonForDate,
  seasonRange,
  SOURCES,
  type AssignmentRow,
  type AssignmentUpdate,
  type BusinessLineOrUnassigned,
  type RetailBreakdownQuery,
  type RetailKpiQuery,
  type RetailSource,
  type RevenueBasis,
  type RevenueQuery,
  type Source,
  type SourceFreshness,
} from "@dash/shared";
import { demoRetailBreakdown, demoRetailKpis, demoShopifyInventory } from "./demoRetail.js";
import { summarizeRows } from "./summarize.js";
import type { DailyRevenueRow, FreshnessSource, Warehouse } from "./types.js";

/**
 * Deterministic made-up numbers so the dashboard can be developed and
 * demoed before (or without) real data. Never used in production.
 */
export function noise(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

type Shape = "retail" | "weekend_retail" | "summer_bookings" | "october" | "camp" | "school_year" | "deals";

/** One platform's slice of one business line. */
export interface DemoStream {
  source: Source;
  businessLine: BusinessLineOrUnassigned;
  revenue: number;
  ticket: number;
  feeRate: number;
  shape: Shape;
}

export const DEMO_STREAMS: DemoStream[] = [
  { source: "campminder", businessLine: "camp", revenue: 7_000, ticket: 1_850, feeRate: 0.03, shape: "camp" },
  { source: "campminder", businessLine: "chaps", revenue: 900, ticket: 450, feeRate: 0.03, shape: "camp" },
  { source: "campminder", businessLine: "school_year", revenue: 1_400, ticket: 600, feeRate: 0.03, shape: "school_year" },
  { source: "fareharbor", businessLine: "river_school", revenue: 2_600, ticket: 145, feeRate: 0.06, shape: "summer_bookings" },
  { source: "fareharbor", businessLine: "events", revenue: 900, ticket: 60, feeRate: 0.06, shape: "summer_bookings" },
  { source: "fareharbor", businessLine: "haunted_forest", revenue: 2_200, ticket: 35, feeRate: 0.06, shape: "october" },
  { source: "hubspot", businessLine: "education", revenue: 3_500, ticket: 6_000, feeRate: 0, shape: "deals" },
  { source: "hubspot", businessLine: "chaps", revenue: 800, ticket: 900, feeRate: 0, shape: "deals" },
  { source: "shopify", businessLine: "river_store", revenue: 2_400, ticket: 68, feeRate: 0.029, shape: "retail" },
  { source: "square", businessLine: "farm_store", revenue: 1_900, ticket: 24, feeRate: 0.026, shape: "weekend_retail" },
  { source: "square", businessLine: "events", revenue: 700, ticket: 18, feeRate: 0.026, shape: "summer_bookings" },
  { source: "square", businessLine: "haunted_forest", revenue: 600, ticket: 12, feeRate: 0.026, shape: "october" },
];

function dayFactor(s: DemoStream, date: string, basis: RevenueBasis): number {
  const d = new Date(`${date}T00:00:00Z`);
  const month = d.getUTCMonth() + 1;
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  const seed = `${s.source}${s.businessLine}${date}`;
  switch (s.shape) {
    case "retail":
      return 1 + (month === 11 || month === 12 ? 1.2 : 0);
    case "weekend_retail":
      return (weekend ? 1.7 : 0.8) * (month >= 5 && month <= 10 ? 1.4 : 0.8);
    case "summer_bookings": {
      const summer = month >= 6 && month <= 8 ? 2.5 : month === 5 || month === 9 ? 1.2 : 0.3;
      return basis === "service" ? summer * (weekend ? 1.6 : 0.9) : summer * 0.9 + 0.2;
    }
    case "october":
      if (basis === "service") return month === 10 ? (weekend ? 9 : 2) : 0;
      return month === 10 ? 4 : month === 9 ? 2 : 0.1;
    case "camp":
      if (basis === "service") return month >= 6 && month <= 8 ? 3 : 0;
      if (basis === "collected") return month >= 1 && month <= 6 ? 1.3 : 0.4;
      return month === 9 || month === 10 ? 2.2 : month >= 1 && month <= 3 ? 1.5 : 0.4;
    case "school_year":
      return month >= 9 || month <= 5 ? 1.2 : 0.2;
    case "deals":
      return noise(`${seed}close`) > 0.7 ? 4 : 0;
  }
}

export function demoRow(s: DemoStream, date: string, basis: RevenueBasis): DailyRevenueRow {
  const growth = Math.pow(1.08, Number(date.slice(0, 4)) - 2026);
  const seed = `${s.source}${s.businessLine}${date}${basis}`;
  const gross = Math.max(0, s.revenue * dayFactor(s, date, basis) * growth * (0.7 + 0.6 * noise(seed)));
  const discounts = gross * 0.04 * noise(`${seed}d`);
  const refunds = gross * 0.03 * noise(`${seed}r`);
  return {
    businessLine: s.businessLine,
    source: s.source,
    date,
    seasonStart: seasonRange(seasonForDate(date)).start,
    gross,
    discounts,
    refunds,
    fees: (gross - refunds) * s.feeRate,
    transactions: Math.round(gross / s.ticket),
  };
}

/** Demo stand-ins for the assignable values (Square locations, the Shopify store). */
const DEMO_CANDIDATES: Array<Omit<AssignmentRow, "businessLine" | "origin"> & { defaultLine: BusinessLineOrUnassigned | null }> = [
  { source: "square", kind: "location", key: "LDEMOFARM", label: "Farm Store", lastActivity: null, netLast12Months: 520_000, defaultLine: "farm_store" },
  { source: "square", kind: "location", key: "LDEMOEVENTS", label: "Events", lastActivity: null, netLast12Months: 140_000, defaultLine: "events" },
  { source: "square", kind: "location", key: "LDEMOPIZZA", label: "Pizza Nights", lastActivity: null, netLast12Months: 45_000, defaultLine: "events" },
  { source: "square", kind: "location", key: "LDEMOMHF", label: "MHF", lastActivity: null, netLast12Months: 160_000, defaultLine: "haunted_forest" },
  { source: "square", kind: "location", key: "LDEMOOLD", label: "Old Kiosk", lastActivity: null, netLast12Months: 0, defaultLine: null },
  { source: "shopify", kind: "store", key: "store", label: "Shopify store", lastActivity: null, netLast12Months: 610_000, defaultLine: "river_store" },
];

export class DemoWarehouse implements Warehouse {
  private readonly saved = new Map<string, BusinessLineOrUnassigned>();

  async revenueSummary(q: RevenueQuery) {
    const ranges = [{ start: q.start, end: q.end }];
    const cmp = comparisonRange(ranges[0]!, q.compare);
    if (cmp) ranges.push(cmp);
    const rows: DailyRevenueRow[] = [];
    for (const r of ranges) {
      for (let d = r.start; d <= r.end; d = addDays(d, 1)) {
        for (const s of DEMO_STREAMS) rows.push(demoRow(s, d, q.basis));
      }
    }
    return summarizeRows(rows, q);
  }

  async retailKpis(source: RetailSource, q: RetailKpiQuery) {
    return demoRetailKpis(source, q);
  }

  async retailBreakdown(source: RetailSource, q: RetailBreakdownQuery) {
    return demoRetailBreakdown(source, q);
  }

  async shopifyInventory() {
    return demoShopifyInventory();
  }

  async assignments() {
    const today = new Date().toISOString().slice(0, 10);
    const rows: AssignmentRow[] = DEMO_CANDIDATES.map(({ defaultLine, ...c }) => {
      const saved = this.saved.get(`${c.source}|${c.kind}|${c.key}`);
      return {
        ...c,
        lastActivity: c.netLast12Months ? today : "2024-10-02",
        businessLine: saved ?? defaultLine ?? "unassigned",
        origin: saved ? "explicit" : defaultLine ? "default" : "none",
      };
    });
    return { rows, pendingRefresh: false };
  }

  async saveAssignments(changes: AssignmentUpdate["changes"]) {
    for (const c of changes) this.saved.set(`${c.source}|${c.kind}|${c.key}`, c.businessLine);
  }
}

export class DemoFreshness implements FreshnessSource {
  async freshness(): Promise<SourceFreshness[]> {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const lag: Record<Source, number> = { shopify: 8, square: 21, hubspot: 95, campminder: 2_400, fareharbor: 300 };
    return SOURCES.map((source) => ({
      source,
      status: "ok",
      lastDataAt: ago(lag[source]),
      lastSuccessAt: ago(lag[source] + 30),
      lastError: null,
    }));
  }
}
