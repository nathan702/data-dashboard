import { addDays, LEAD_BUCKETS, NIGHTLY_LINES, type BusinessLine, type FareharborDayRow } from "@dash/shared";
import type { FareharborDaysScope } from "./types.js";

/** Made-up FareHarbor bookings for local development (no warehouse). */
const ITEMS: Record<string, Array<{ name: string; price: number; share: number }>> = {
  haunted_forest: [
    { name: "Haunted Trail", price: 45, share: 0.48 },
    { name: "Haunted Town", price: 40, share: 0.09 },
    { name: "Combo: Trail + Town", price: 70, share: 0.41 },
    { name: "Upside Down Express Access Pass", price: 175, share: 0.02 },
  ],
  river_school: [
    { name: "Kayak Lesson", price: 85, share: 0.5 },
    { name: "Paddleboard Tour", price: 65, share: 0.3 },
    { name: "Private Lesson", price: 150, share: 0.2 },
  ],
  events: [{ name: "Pizza Night", price: 30, share: 1 }],
};
const LEAD_SHARE = [0.08, 0.07, 0.15, 0.2, 0.25, 0.11, 0.05, 0.05, 0.03, 0.01];

const rand = (seed: number) => {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
};

function demoDays(line: BusinessLine, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const month = Number(d.slice(5, 7));
    if (line === "haunted_forest") {
      if ((month === 10 || (month === 11 && Number(d.slice(8)) <= 8) || (month === 9 && Number(d.slice(8)) >= 30)) && [0, 4, 5, 6].includes(dow)) out.push(d);
    } else if (dow === 1 && month >= 4 && month <= 10) out.push(d);
  }
  return out;
}

export function demoFareharborDays(q: FareharborDaysScope): FareharborDayRow[] {
  const items = ITEMS[q.businessLine];
  if (!items) return [];
  const nightly = NIGHTLY_LINES.includes(q.businessLine);
  const rows: FareharborDayRow[] = [];
  for (const day of demoDays(q.businessLine, q.from, q.to)) {
    const seed = Number(day.replaceAll("-", ""));
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const base = nightly ? (dow === 6 ? 3200 : dow === 5 ? 2600 : 1700) : 180;
    const guests = Math.round(base * (0.8 + rand(seed) * 0.4) * (day.startsWith("2026") ? 0.93 : 1));
    for (const item of items) {
      LEAD_BUCKETS.forEach((lead, i) => {
        const g = Math.round(guests * item.share * LEAD_SHARE[i]!);
        if (!g) return;
        const leadDays = [0, 1, 3, 6, 13, 20, 27, 41, 55, 70][i]!;
        const bookedBy = addDays(day, -leadDays) <= q.cutoff;
        const revenue = Math.round(g * item.price * 100) / 100;
        rows.push({ day, item: item.name, lead, revenue, guests: g, bookings: Math.ceil(g / 3), revenueAtSamePoint: bookedBy ? revenue : 0, guestsAtSamePoint: bookedBy ? g : 0 });
      });
    }
  }
  return rows;
}

export function demoFareharborExtent(line: BusinessLine) {
  return ITEMS[line] ? { firstDay: "2024-01-01", lastDay: "2026-12-31" } : null;
}
