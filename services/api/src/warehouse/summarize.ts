import {
  alignToCurrent,
  BUSINESS_LINES_WITH_UNASSIGNED,
  SOURCES,
  comparisonRange,
  seasonForDate,
  seasonRange,
  type Granularity,
  type RevenueMeasure,
  type RevenueQuery,
  type RevenueSummaryResponse,
  type RevenueTotals,
} from "@dash/shared";
import type { DailyRevenueRow } from "./types.js";

export function emptyTotals(): RevenueTotals {
  return { gross: 0, discounts: 0, refunds: 0, fees: 0, net: 0, netAfterFees: 0, transactions: 0 };
}

export function addRow(t: RevenueTotals, r: DailyRevenueRow) {
  t.gross += r.gross;
  t.discounts += r.discounts;
  t.refunds += r.refunds;
  t.fees += r.fees;
  t.transactions += r.transactions;
  t.net = t.gross - t.discounts - t.refunds;
  t.netAfterFees = t.net - t.fees;
}

export function measureValue(t: RevenueTotals, m: RevenueMeasure): number {
  return m === "gross" ? t.gross : m === "net" ? t.net : t.netAfterFees;
}

export function periodBucket(date: string, seasonStart: string, g: Granularity): string {
  switch (g) {
    case "day":
      return date;
    case "month":
      return `${date.slice(0, 7)}-01`;
    case "season":
      return seasonStart;
    case "week": {
      const d = new Date(`${date}T00:00:00Z`);
      const offset = (d.getUTCDay() + 6) % 7; // Monday-start weeks, like BigQuery WEEK(MONDAY)
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString().slice(0, 10);
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function roundTotals(t: RevenueTotals): RevenueTotals {
  return {
    gross: round2(t.gross),
    discounts: round2(t.discounts),
    refunds: round2(t.refunds),
    fees: round2(t.fees),
    net: round2(t.net),
    netAfterFees: round2(t.netAfterFees),
    transactions: t.transactions,
  };
}

/** The keys a query's groups cover, in display order. */
export function groupKeys(q: RevenueQuery): string[] {
  if (q.groupBy === "source") return q.sources?.length ? [...q.sources] : [...SOURCES];
  return q.businessLines?.length ? [...q.businessLines] : [...BUSINESS_LINES_WITH_UNASSIGNED];
}

function rowMatches(r: DailyRevenueRow, q: RevenueQuery): boolean {
  if (q.businessLines?.length && !q.businessLines.includes(r.businessLine)) return false;
  if (q.sources?.length && !q.sources.includes(r.source)) return false;
  return true;
}

/**
 * Aggregate daily rows the same way the BigQuery SQL does. Used by the demo
 * warehouse, and as the reference the SQL is tested against.
 */
export function summarizeRows(rows: DailyRevenueRow[], q: RevenueQuery): RevenueSummaryResponse {
  const keys = groupKeys(q);
  const keyOf = (r: DailyRevenueRow) => (q.groupBy === "source" ? r.source : r.businessLine);
  const cmp = comparisonRange({ start: q.start, end: q.end }, q.compare);
  const current = new Map<string, RevenueTotals>(keys.map((k) => [k, emptyTotals()]));
  const comparison = new Map<string, RevenueTotals>(keys.map((k) => [k, emptyTotals()]));
  const series = new Map<string, RevenueTotals>();
  const cmpSeries = new Map<string, RevenueTotals>();

  for (const r of rows) {
    if (!rowMatches(r, q)) continue;
    const key = keyOf(r);
    if (!current.has(key)) continue;
    if (r.date >= q.start && r.date <= q.end) {
      addRow(current.get(key)!, r);
      const sk = `${periodBucket(r.date, r.seasonStart, q.granularity)}|${key}`;
      const t = series.get(sk) ?? emptyTotals();
      addRow(t, r);
      series.set(sk, t);
    } else if (cmp && r.date >= cmp.start && r.date <= cmp.end) {
      addRow(comparison.get(key)!, r);
      const aligned = alignToCurrent(r.date, { start: q.start, end: q.end }, q.compare);
      const sk = `${periodBucket(aligned, seasonRange(seasonForDate(aligned)).start, q.granularity)}|${key}`;
      const t = cmpSeries.get(sk) ?? emptyTotals();
      addRow(t, r);
      cmpSeries.set(sk, t);
    }
  }

  return {
    range: { start: q.start, end: q.end },
    comparisonRange: cmp,
    groupBy: q.groupBy,
    groups: keys.map((k) => ({
      key: k,
      current: roundTotals(current.get(k)!),
      comparison: cmp ? roundTotals(comparison.get(k)!) : null,
    })),
    series: toSeries(series, q.measure),
    comparisonSeries: toSeries(cmpSeries, q.measure),
    generatedAt: new Date().toISOString(),
  };
}

function toSeries(m: Map<string, RevenueTotals>, measure: RevenueMeasure) {
  return [...m.entries()]
    .map(([sk, t]) => {
      const [period, key] = sk.split("|") as [string, string];
      return { period, key, value: round2(measureValue(t, measure)) };
    })
    .sort((a, b) => a.period.localeCompare(b.period) || a.key.localeCompare(b.key));
}
