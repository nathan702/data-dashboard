import {
  addDays,
  comparisonRange,
  SOURCES,
  type AssignmentRow,
  type AssignmentUpdate,
  type BusinessLineOrUnassigned,
  type EnrollmentBreakdownQuery,
  type EnrollmentMapQuery,
  type EnrollmentSummaryQuery,
  type CampminderExtrasQuery,
  type CampminderFinanceQuery,
  type RegistrationPaceQuery,
  type RegistrationSettings,
  type RetailBreakdownQuery,
  type RetailKpiQuery,
  type RetailSource,
  type RevenueBasis,
  CALENDAR_YEAR,
  type ProgramFamilySettings,
  type ReportSpec,
  type RevenueQuery,
  type SeasonCalendar,
  type Source,
  type SourceFreshness,
  easternDate,
  emptyTargetActuals,
  BUSINESS_LINE_INFO,
  type TargetActuals,
  type TargetSettings,
} from "@dash/shared";
import { demoRunReport } from "./demoReports.js";
import { demoFareharborDays, demoFareharborExtent } from "./demoFareharbor.js";
import type { SchoolMap } from "./reportSql.js";
import { DEMO_SESSION_GROUPS, demoCampLineItems, demoCampminderExtras, demoCampminderFinance, demoRegistrationPace, demoEnrollmentRows, demoEnrollmentBreakdown, demoEnrollmentMap, demoEnrollmentSeasons, demoEnrollmentSummary } from "./demoCampminder.js";
import { demoRetailBreakdown, demoRetailKpis, demoShopifyInventory } from "./demoRetail.js";
import { summarizeRows } from "./summarize.js";
import type { DailyRevenueRow, FareharborDaysScope, FreshnessSource, HubspotProgramsScope, TargetActualsScope, Warehouse } from "./types.js";
import { DEMO_HUBSPOT_PROPERTIES, demoHubspotPrograms } from "./demoHubspot.js";

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
    gross,
    discounts,
    refunds,
    fees: (gross - refunds) * s.feeRate,
    transactions: Math.round(gross / s.ticket),
  };
}

/** Sample targets for this year and next, roughly last year's totals plus a little. */
const thisYear = Number(easternDate().slice(0, 4));
export const DEMO_TARGETS: TargetSettings = {
  seasons: {
    [String(thisYear)]: {
      camp: { revenue: 1_800_000, campers: 2_500, enrollments: 6_600 },
      river_school: { revenue: 1_100_000, guests: 5_000 },
      haunted_forest: { revenue: 320_000, guests: 52_000 },
      education: { participants: 4_000 },
      farm_store: { revenue: 950_000 },
      river_store: { revenue: 1_000_000 },
    },
    [String(thisYear + 1)]: {
      camp: { revenue: 1_950_000, campers: 2_650, enrollments: 6_900 },
    },
  },
};

/** Demo stand-ins for the assignable values (Square locations, the Shopify store). */
const DEMO_CANDIDATES: Array<Omit<AssignmentRow, "businessLine" | "origin" | "lastActivity"> & { defaultLine: BusinessLineOrUnassigned | null }> = [
  { source: "square", kind: "location", key: "LDEMOFARM", label: "Farm Store", netLast12Months: 520_000, activityLast12Months: 21_000, defaultLine: "farm_store" },
  { source: "square", kind: "location", key: "LDEMOEVENTS", label: "Events", netLast12Months: 140_000, activityLast12Months: 7_800, defaultLine: "events" },
  { source: "square", kind: "location", key: "LDEMOPIZZA", label: "Pizza Nights", netLast12Months: 45_000, activityLast12Months: 2_600, defaultLine: "events" },
  { source: "square", kind: "location", key: "LDEMOMHF", label: "MHF", netLast12Months: 160_000, activityLast12Months: 13_000, defaultLine: "haunted_forest" },
  { source: "square", kind: "location", key: "LDEMOOLD", label: "Old Kiosk", netLast12Months: 0, activityLast12Months: 0, defaultLine: null },
  { source: "shopify", kind: "store", key: "store", label: "Shopify store", netLast12Months: 610_000, activityLast12Months: 9_400, defaultLine: "river_store" },
  ...DEMO_SESSION_GROUPS.map((g) => ({
    source: "campminder" as const,
    kind: "session",
    key: g.key,
    label: g.label,
    netLast12Months: 0,
    activityLast12Months: g.activity,
    defaultLine: g.defaultLine,
  })),
];

export class DemoWarehouse implements Warehouse {
  private readonly saved = new Map<string, BusinessLineOrUnassigned>();

  async revenueSummary(q: RevenueQuery, seasons: SeasonCalendar) {
    const ranges = [{ start: q.start, end: q.end }];
    const cmp = comparisonRange(ranges[0]!, q.compare);
    if (cmp) ranges.push(cmp);
    const rows: DailyRevenueRow[] = [];
    for (const r of ranges) {
      for (let d = r.start; d <= r.end; d = addDays(d, 1)) {
        for (const s of DEMO_STREAMS) rows.push(demoRow(s, d, q.basis));
      }
    }
    return summarizeRows(rows, q, seasons);
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
        lastActivity: c.netLast12Months || c.activityLast12Months ? today : "2024-10-02",
        businessLine: saved ?? defaultLine ?? "unassigned",
        origin: saved ? "explicit" : defaultLine ? "default" : "none",
      };
    });
    return { rows, pendingRefresh: false };
  }

  async enrollmentSeasons(bl: BusinessLineOrUnassigned | undefined) {
    return demoEnrollmentSeasons(bl);
  }

  async enrollmentSummary(q: EnrollmentSummaryQuery, seasons: SeasonCalendar, schools?: SchoolMap) {
    return demoEnrollmentSummary(q, seasons, schools);
  }

  async enrollmentMap(q: EnrollmentMapQuery, schools?: SchoolMap) {
    return demoEnrollmentMap(q, schools);
  }

  async enrollmentBreakdown(q: EnrollmentBreakdownQuery, schools?: SchoolMap) {
    return demoEnrollmentBreakdown(q, schools);
  }

  async runReport(spec: ReportSpec, families: ProgramFamilySettings, schools?: SchoolMap) {
    return demoRunReport(spec, families, schools);
  }

  async hubspotProperties() {
    return DEMO_HUBSPOT_PROPERTIES;
  }

  async hubspotExtent(businessLine: Parameters<typeof demoFareharborExtent>[0]) {
    return businessLine === "education" || businessLine === "chaps" ? { firstDay: "2024-09-01", lastDay: "2027-06-30" } : null;
  }

  async hubspotPrograms(q: HubspotProgramsScope) {
    return demoHubspotPrograms(q);
  }

  async hubspotDeals(businessLine: Parameters<typeof demoFareharborExtent>[0]) {
    if (businessLine !== "education" && businessLine !== "chaps") return { businessLine, open: [], won: [] };
    const scale = businessLine === "education" ? 6000 : 900;
    const open = [
      { pipeline: businessLine === "education" ? "Field trips" : "CHAPs groups", stage: "Inquiry", stageOrder: 0, deals: 14, amount: 14 * scale * 0.8 },
      { pipeline: businessLine === "education" ? "Field trips" : "CHAPs groups", stage: "Proposal sent", stageOrder: 1, deals: 9, amount: 9 * scale },
      { pipeline: businessLine === "education" ? "Field trips" : "CHAPs groups", stage: "Deposit paid", stageOrder: 2, deals: 5, amount: 5 * scale * 1.1 },
    ];
    const won = Array.from({ length: 24 }, (_, i) => {
      const dt = new Date(Date.UTC(2024, 11 + i, 1));
      const month = dt.toISOString().slice(0, 10);
      const deals = 3 + ((i * 7) % 6);
      return { month, deals, amount: deals * scale };
    });
    return { businessLine, open, won };
  }

  async fareharborDays(q: FareharborDaysScope) {
    return demoFareharborDays(q);
  }

  async fareharborExtent(line: Parameters<typeof demoFareharborExtent>[0]) {
    return demoFareharborExtent(line);
  }

  async registrationPace(q: RegistrationPaceQuery, registration: RegistrationSettings, schools?: SchoolMap) {
    return demoRegistrationPace(q, registration, schools);
  }

  async campminderFinance(q: CampminderFinanceQuery, schools?: SchoolMap) {
    return demoCampminderFinance(q, schools);
  }

  async campminderExtras(q: CampminderExtrasQuery, cutoff: string, items: string[]) {
    return demoCampminderExtras(q, cutoff, items);
  }

  async campLineItems() {
    return demoCampLineItems();
  }

  async schoolList() {
    const campers = new Map<string, Set<string>>();
    for (const r of demoEnrollmentRows()) {
      if (r.school === null) continue;
      const set = campers.get(r.school) ?? new Set<string>();
      if (r.statusCode === "EN") set.add(r.camper);
      campers.set(r.school, set);
    }
    return [...campers].map(([entered, s]) => ({ entered, campers: s.size })).sort((a, b) => b.campers - a.campers || a.entered.localeCompare(b.entered));
  }

  async programList() {
    const counts = new Map<string, number>();
    for (const r of demoEnrollmentRows()) if (r.program && r.statusCode === "EN") counts.set(r.program, (counts.get(r.program) ?? 0) + 1);
    return [...counts].map(([program, enrollments]) => ({ program, enrollments })).sort((a, b) => b.enrollments - a.enrollments);
  }

  async targetActuals(q: TargetActualsScope): Promise<TargetActuals> {
    const today = easternDate();
    const out = emptyTargetActuals();
    const inCur = (d: string) => d >= q.current.start && d <= q.current.end;
    const inPrev = (d: string) => d >= q.previous.start && d <= q.previous.end;
    // Revenue: each service day's net, booked a made-up number of days ahead (more for camp and deals).
    const leadDays: Record<string, number> = { camp: 270, school_year: 60, summer_bookings: 30, october: 25, deals: 120, retail: 0, weekend_retail: 0 };
    for (const s of DEMO_STREAMS.filter((x) => x.businessLine === q.businessLine)) {
      for (let d = q.previous.start; d <= q.current.end; d = addDays(d, 1)) {
        if (!inCur(d) && !inPrev(d)) continue;
        const r = demoRow(s, d, "service");
        const net = r.gross - r.discounts - r.refunds;
        const booked = addDays(d, -Math.round((leadDays[s.shape] ?? 0) * noise(`${d}${s.source}lead`)));
        const m = out.revenue;
        if (inCur(d) && booked <= today) m.current += net;
        if (inPrev(d)) {
          m.previousFinal += net;
          if (booked <= q.cutoff) m.previousAtSamePoint += net;
        }
      }
    }
    for (const k of ["current", "previousAtSamePoint", "previousFinal"] as const) out.revenue[k] = Math.round(out.revenue[k] * 100) / 100;
    // Guests: FareHarbor's demo nights, booked by today (this season) or the cutoff (last season).
    if (BUSINESS_LINE_INFO[q.businessLine].sources.includes("fareharbor")) {
      const scope = { businessLine: q.businessLine, from: q.previous.start, to: q.current.end, nightly: true };
      for (const r of demoFareharborDays({ ...scope, cutoff: today })) if (inCur(r.day)) out.guests.current += r.guestsAtSamePoint;
      for (const r of demoFareharborDays({ ...scope, cutoff: q.cutoff })) {
        if (!inPrev(r.day)) continue;
        out.guests.previousFinal += r.guests;
        out.guests.previousAtSamePoint += r.guestsAtSamePoint;
      }
    }
    // Participants: the demo HubSpot programs.
    if (q.businessLine === "education" || q.businessLine === "chaps") {
      const roles = { participants: q.participantProps, chaperones: [], programType: [], food: [], transportation: [] };
      const { programs } = demoHubspotPrograms({ businessLine: q.businessLine, from: q.previous.start, to: q.current.end, currentStart: q.current.start, cutoff: q.cutoff, roles });
      for (const p of programs) {
        if (p.period === "current") out.participants.current += p.participants;
        else {
          out.participants.previousFinal += p.participants;
          if (p.atSamePoint) out.participants.previousAtSamePoint += p.participants;
        }
      }
    }
    // Campers and enrollments: the demo Campminder rows.
    const en = demoEnrollmentRows().filter((r) => r.businessLine === q.businessLine && r.statusCode === "EN");
    const count = (rows: typeof en) => ({ campers: new Set(rows.map((r) => r.camper)).size, enrollments: rows.length });
    const cur = count(en.filter((r) => r.season === q.season));
    const prev = en.filter((r) => r.season === q.season - 1);
    const prevFinal = count(prev);
    const prevSp = count(prev.filter((r) => r.applicationDate <= q.cutoff));
    for (const m of ["campers", "enrollments"] as const) out[m] = { current: cur[m], previousAtSamePoint: prevSp[m], previousFinal: prevFinal[m] };
    return out;
  }

  async referenceTotals(start: string, end: string) {
    // The demo's own summaries are its reference.
    const s = await this.revenueSummary({ start, end, basis: "booked", measure: "gross", granularity: "week", compare: "none", groupBy: "source" }, CALENDAR_YEAR);
    const k = async (src: RetailSource) => (await this.retailKpis(src, { start, end, compare: "none", filters: {} })).current.gross;
    const svc = await this.revenueSummary({ start, end, basis: "service", measure: "net", granularity: "week", compare: "none", groupBy: "business_line" }, CALENDAR_YEAR);
    return {
      revenueGross: s.groups.reduce((t, g) => t + g.current.gross, 0),
      serviceNet: svc.groups.filter((g) => g.key !== "unassigned").reduce((t, g) => t + g.current.net, 0),
      retailGross: { shopify: await k("shopify"), square: await k("square") },
      enrollments: (() => {
        const newest = demoEnrollmentSeasons(undefined)[0];
        return newest ? { season: newest.season, count: newest.enrollments } : null;
      })(),
    };
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
