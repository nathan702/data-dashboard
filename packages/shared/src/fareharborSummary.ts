import { addDays, type IsoDate } from "./dates.js";
import {
  CORE_TICKET_TYPES,
  LEAD_BUCKETS,
  LEAD_GROUPS,
  matchingDay,
  MATCH_OFFSET_DAYS,
  ticketTypeFor,
  TICKET_TYPE_LABEL,
  type FareharborDaysResponse,
  type LeadBucket,
} from "./fareharbor.js";

/**
 * Turns the FareHarbor days response into what the page shows: totals for
 * days already held (final) and upcoming (sold so far), each against last
 * season, night by night and by group (ticket type for the Haunted Forest,
 * item elsewhere), and when tickets were bought.
 *
 * Closed days are left out; so is last season's match of a closed day. A day
 * whose match last season was closed stays in, unmatched.
 */

export interface Metrics {
  revenue: number;
  guests: number;
  byGroup: Record<string, { revenue: number; guests: number }>;
}

export interface DaySummary {
  /** Where the day sits on this season's calendar (last season's days are moved forward 364 days). */
  aligned: IsoDate;
  label: string;
  day: IsoDate | null;
  previousDay: IsoDate | null;
  held: boolean;
  /** This season's numbers (null when only last season had this day). */
  current: Metrics | null;
  /** Last season, final. */
  previous: Metrics | null;
  /** Last season, bookings made by the same point. */
  previousAtSamePoint: Metrics | null;
}

export interface Totals {
  days: number;
  current: Metrics;
}

export interface FareharborSummary {
  groups: string[];
  groupLabel: (g: string) => string;
  /** Groups compared year over year (Town, Trail, Combo; every item elsewhere). */
  comparedGroups: string[];
  days: DaySummary[];
  held: {
    current: Totals;
    previous: Totals;
    /** Days held this season whose match was open last season, both years. */
    matching: { days: number; current: Metrics; previous: Metrics; previousAtSamePoint: Metrics };
    /** This season's held days without a match last season. */
    unmatched: Totals;
  };
  upcoming: { current: Totals; previousAtSamePoint: Totals; matchingDays: number };
  lead: {
    buckets: LeadBucket[];
    current: number[];
    previousAtSamePoint: number[];
    previousFinal: number[];
    /** Per weekend (nightly lines): guests by LEAD_GROUPS. */
    byWeekend: { current: WeekendLead[]; previous: WeekendLead[] };
  };
}

export interface WeekendLead {
  label: string;
  from: IsoDate;
  to: IsoDate;
  guests: number;
  /** Guests per LEAD_GROUPS entry. */
  groups: number[];
}

const empty = (): Metrics => ({ revenue: 0, guests: 0, byGroup: {} });
const add = (m: Metrics, group: string, revenue: number, guests: number) => {
  m.revenue += revenue;
  m.guests += guests;
  const g = (m.byGroup[group] ??= { revenue: 0, guests: 0 });
  g.revenue += revenue;
  g.guests += guests;
};
const merge = (into: Metrics, m: Metrics | null) => {
  if (!m) return;
  for (const [g, v] of Object.entries(m.byGroup)) add(into, g, v.revenue, v.guests);
};
const round = (m: Metrics): Metrics => ({
  revenue: Math.round(m.revenue * 100) / 100,
  guests: m.guests,
  byGroup: Object.fromEntries(Object.entries(m.byGroup).map(([k, v]) => [k, { revenue: Math.round(v.revenue * 100) / 100, guests: v.guests }])),
});

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const dow = (d: IsoDate) => new Date(`${d}T00:00:00Z`).getUTCDay();
const monday = (d: IsoDate) => addDays(d, -((dow(d) + 6) % 7));
const diffDays = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const shortDate = (d: IsoDate) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export function summarizeFareharbor(r: FareharborDaysResponse): FareharborSummary {
  const nightly = r.nightly;
  const groupOf = (item: string) => (nightly ? ticketTypeFor(item, r.itemTypes) : item);
  const closed = new Set(r.closures.map((c) => c.date));
  // A weekly row is the Monday of its week; it belongs to the season its Thursday falls in.
  const seasonDay = (day: IsoDate) => (nightly ? day : addDays(day, 3));
  const inCurrent = (day: IsoDate) => seasonDay(day) >= r.current.start && seasonDay(day) <= r.current.end;
  const inPrevious = (day: IsoDate) => seasonDay(day) >= r.previous.start && seasonDay(day) <= r.previous.end;

  const cur = new Map<IsoDate, Metrics>();
  const prev = new Map<IsoDate, Metrics>();
  const prevSp = new Map<IsoDate, Metrics>();
  const leadCur = new Map<LeadBucket, number>();
  const leadPrev = new Map<LeadBucket, number>();
  const leadPrevSp = new Map<LeadBucket, number>();
  const leadByDayCur = new Map<IsoDate, Map<LeadBucket, number>>();
  const leadByDayPrev = new Map<IsoDate, Map<LeadBucket, number>>();
  const groups = new Set<string>();
  const countsForLead = (g: string) => !nightly || (CORE_TICKET_TYPES as string[]).includes(g);
  const bump = (m: Map<LeadBucket, number>, b: LeadBucket, n: number) => m.set(b, (m.get(b) ?? 0) + n);

  for (const row of r.rows) {
    const g = groupOf(row.item);
    groups.add(g);
    if (inCurrent(row.day)) {
      if (closed.has(row.day)) continue;
      add(cur.get(row.day) ?? cur.set(row.day, empty()).get(row.day)!, g, row.revenue, row.guests);
      if (countsForLead(g)) {
        bump(leadCur, row.lead, row.guests);
        bump(leadByDayCur.get(row.day) ?? leadByDayCur.set(row.day, new Map()).get(row.day)!, row.lead, row.guests);
      }
    } else if (inPrevious(row.day)) {
      // Last season's day is out when it was closed, or when its match this season was.
      if (closed.has(row.day) || closed.has(addDays(row.day, MATCH_OFFSET_DAYS))) continue;
      add(prev.get(row.day) ?? prev.set(row.day, empty()).get(row.day)!, g, row.revenue, row.guests);
      add(prevSp.get(row.day) ?? prevSp.set(row.day, empty()).get(row.day)!, g, row.revenueAtSamePoint, row.guestsAtSamePoint);
      if (countsForLead(g)) {
        bump(leadPrev, row.lead, row.guests);
        bump(leadPrevSp, row.lead, row.guestsAtSamePoint);
        bump(leadByDayPrev.get(row.day) ?? leadByDayPrev.set(row.day, new Map()).get(row.day)!, row.lead, row.guests);
      }
    }
  }
  const open = (m: Metrics | undefined) => !!m && (m.guests > 0 || m.revenue > 0);

  // Weekend numbering starts at each season's first open night.
  const firstOf = (m: Map<IsoDate, Metrics>) => [...m.keys()].filter((d) => open(m.get(d))).sort()[0];
  const curFirst = firstOf(cur) ?? (firstOf(prev) ? addDays(firstOf(prev)!, MATCH_OFFSET_DAYS) : undefined);
  const weekendOf = (d: IsoDate, first: IsoDate | undefined) => (first ? Math.floor(diffDays(monday(first), d) / 7) + 1 : 1);
  const label = (aligned: IsoDate) =>
    nightly ? `${ordinal(Math.max(1, weekendOf(aligned, curFirst)))} ${WEEKDAY[dow(aligned)]}` : `Week of ${shortDate(aligned)}`;

  const alignedDays = new Set<IsoDate>([...cur.keys()].filter((d) => open(cur.get(d))));
  for (const d of prev.keys()) if (open(prev.get(d))) alignedDays.add(addDays(d, MATCH_OFFSET_DAYS));
  for (const c of r.closures) if (inCurrent(c.date)) alignedDays.add(c.date);
  const days: DaySummary[] = [...alignedDays].sort().map((aligned) => {
    const p = matchingDay(aligned);
    const isClosed = closed.has(aligned);
    return {
      aligned,
      label: label(aligned),
      day: open(cur.get(aligned)) || isClosed ? aligned : null,
      previousDay: open(prev.get(p)) ? p : null,
      held: aligned < r.asOf,
      current: isClosed ? null : open(cur.get(aligned)) ? round(cur.get(aligned)!) : null,
      previous: open(prev.get(p)) ? round(prev.get(p)!) : null,
      previousAtSamePoint: open(prev.get(p)) ? round(prevSp.get(p) ?? empty()) : null,
    };
  });

  const sum = (list: Array<Metrics | null>) => {
    const t = empty();
    for (const m of list) merge(t, m);
    return round(t);
  };
  const heldCur = days.filter((d) => d.held && d.current);
  const heldMatch = heldCur.filter((d) => d.previous);
  const upcoming = days.filter((d) => !d.held && d.current);
  const upcomingMatch = days.filter((d) => !d.held && d.previous);

  const leadArr = (m: Map<LeadBucket, number>) => LEAD_BUCKETS.map((b) => m.get(b) ?? 0);
  const weekends = (byDay: Map<IsoDate, Map<LeadBucket, number>>, first: IsoDate | undefined): WeekendLead[] => {
    if (!nightly) return [];
    const out = new Map<number, WeekendLead>();
    for (const [day, buckets] of byDay) {
      const n = weekendOf(day, first);
      const w = out.get(n) ?? { label: `${ordinal(n)} Wknd`, from: day, to: day, guests: 0, groups: LEAD_GROUPS.map(() => 0) };
      if (day < w.from) w.from = day;
      if (day > w.to) w.to = day;
      LEAD_GROUPS.forEach((g, i) => {
        for (const b of g.buckets) {
          w.groups[i]! += buckets.get(b) ?? 0;
          w.guests += buckets.get(b) ?? 0;
        }
      });
      out.set(n, w);
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
  };

  const groupList = [...groups];
  const order = nightly ? (Object.keys(TICKET_TYPE_LABEL) as string[]) : groupList.sort();
  const sortedGroups = order.filter((g) => groups.has(g));
  return {
    groups: sortedGroups,
    groupLabel: (g) => (nightly ? TICKET_TYPE_LABEL[g as keyof typeof TICKET_TYPE_LABEL] ?? g : g),
    comparedGroups: nightly ? sortedGroups.filter((g) => (CORE_TICKET_TYPES as string[]).includes(g)) : sortedGroups,
    days,
    held: {
      current: { days: heldCur.length, current: sum(heldCur.map((d) => d.current)) },
      previous: { days: [...prev.values()].filter(open).length, current: sum([...prev.values()].filter(open)) },
      matching: {
        days: heldMatch.length,
        current: sum(heldMatch.map((d) => d.current)),
        previous: sum(heldMatch.map((d) => d.previous)),
        previousAtSamePoint: sum(heldMatch.map((d) => d.previousAtSamePoint)),
      },
      unmatched: { days: heldCur.length - heldMatch.length, current: sum(heldCur.filter((d) => !d.previous).map((d) => d.current)) },
    },
    upcoming: {
      current: { days: upcoming.length, current: sum(upcoming.map((d) => d.current)) },
      previousAtSamePoint: { days: upcomingMatch.length, current: sum(upcomingMatch.map((d) => d.previousAtSamePoint)) },
      matchingDays: upcoming.filter((d) => d.previous).length,
    },
    lead: {
      buckets: [...LEAD_BUCKETS],
      current: leadArr(leadCur),
      previousAtSamePoint: leadArr(leadPrevSp),
      previousFinal: leadArr(leadPrev),
      byWeekend: { current: weekends(leadByDayCur, firstOf(cur)), previous: weekends(leadByDayPrev, firstOf(prev)) },
    },
  };
}

/** Revenue per guest, 0 when there are no guests. */
export const perGuest = (m: Metrics) => (m.guests > 0 ? Math.round((m.revenue / m.guests) * 100) / 100 : 0);
