import {
  addDays,
  BUSINESS_LINES,
  comparisonRange,
  seasonForDate,
  seasonRange,
  type BusinessLine,
  type RevenueBasis,
  type RevenueQuery,
  type SourceFreshness,
} from "@dash/shared";
import { summarizeRows } from "./summarize.js";
import type { DailyRevenueRow, FreshnessSource, Warehouse } from "./types.js";

/**
 * Deterministic made-up numbers so the dashboard can be developed and
 * demoed before any real source is connected. Never used in production.
 */
function noise(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

function dayFactor(line: BusinessLine, date: string, basis: RevenueBasis): number {
  const d = new Date(`${date}T00:00:00Z`);
  const month = d.getUTCMonth() + 1;
  const weekday = d.getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  switch (line) {
    case "shopify":
      return 1 + (month === 11 || month === 12 ? 1.2 : 0);
    case "square":
      return (weekend ? 1.7 : 0.8) * (month >= 5 && month <= 9 ? 1.4 : 1);
    case "fareharbor": {
      const summer = month >= 6 && month <= 8 ? 2.5 : month === 5 || month === 9 ? 1.2 : 0.3;
      return basis === "service" ? summer * (weekend ? 1.6 : 0.9) : summer * 0.9 + 0.2;
    }
    case "campminder":
      if (basis === "service") return month >= 6 && month <= 8 ? 3 : 0;
      if (basis === "collected") return month >= 1 && month <= 6 ? 1.3 : 0.4;
      return month === 9 || month === 10 ? 2.2 : month >= 1 && month <= 3 ? 1.5 : 0.4;
    case "hubspot":
      return noise(`${line}${date}close`) > 0.7 ? 4 : 0;
  }
}

const BASE: Record<BusinessLine, { revenue: number; ticket: number; feeRate: number }> = {
  shopify: { revenue: 2_400, ticket: 68, feeRate: 0.029 },
  square: { revenue: 3_100, ticket: 24, feeRate: 0.026 },
  fareharbor: { revenue: 4_200, ticket: 145, feeRate: 0.06 },
  campminder: { revenue: 9_500, ticket: 1_850, feeRate: 0.03 },
  hubspot: { revenue: 6_000, ticket: 12_000, feeRate: 0 },
};

export function demoRow(line: BusinessLine, date: string, basis: RevenueBasis): DailyRevenueRow {
  const b = BASE[line];
  const yearsFrom2026 = Number(date.slice(0, 4)) - 2026;
  const growth = Math.pow(1.08, yearsFrom2026);
  const gross = Math.max(0, b.revenue * dayFactor(line, date, basis) * growth * (0.7 + 0.6 * noise(`${line}${date}${basis}`)));
  const discounts = gross * 0.04 * noise(`${line}${date}d`);
  const refunds = gross * 0.03 * noise(`${line}${date}r`);
  return {
    businessLine: line,
    date,
    seasonStart: seasonRange(seasonForDate(date)).start,
    gross,
    discounts,
    refunds,
    fees: (gross - refunds) * b.feeRate,
    transactions: Math.round(gross / b.ticket),
  };
}

export class DemoWarehouse implements Warehouse {
  async revenueSummary(q: RevenueQuery) {
    const lines = q.businessLines?.length ? q.businessLines : [...BUSINESS_LINES];
    const ranges = [{ start: q.start, end: q.end }];
    const cmp = comparisonRange(ranges[0]!, q.compare);
    if (cmp) ranges.push(cmp);
    const rows: DailyRevenueRow[] = [];
    for (const r of ranges) {
      for (let d = r.start; d <= r.end; d = addDays(d, 1)) {
        for (const line of lines) rows.push(demoRow(line, d, q.basis));
      }
    }
    return summarizeRows(rows, q, lines);
  }
}

export class DemoFreshness implements FreshnessSource {
  async freshness(): Promise<SourceFreshness[]> {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const lag: Record<BusinessLine, number> = { shopify: 8, square: 21, hubspot: 95, campminder: 2_400, fareharbor: 300 };
    return BUSINESS_LINES.map((source) => ({
      source,
      status: "ok",
      lastDataAt: ago(lag[source]),
      lastSuccessAt: ago(lag[source] + 30),
      lastError: null,
    }));
  }
}
