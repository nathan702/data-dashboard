import type { HubspotLineItemRow, HubspotProgramRow, HubspotProperty } from "@dash/shared";
import type { HubspotProgramsScope } from "./types.js";

/** Made-up HubSpot programs for local development (no warehouse). */
export const DEMO_HUBSPOT_PROPERTIES: HubspotProperty[] = [
  { name: "number_of_participants", label: "Number of participants", type: "number", options: [] },
  { name: "free_chaperone_count", label: "Free chaperone count", type: "number", options: [] },
  { name: "paid_chaperone_count", label: "Paid chaperone count", type: "number", options: [] },
  {
    name: "program_type",
    label: "Program Type",
    type: "enumeration",
    options: [
      { value: "field_trip", label: "Field trip" },
      { value: "overnight", label: "Overnight" },
      { value: "scout_day", label: "Scout day" },
    ],
  },
  { name: "food_service", label: "Using our food?", type: "bool", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] },
  { name: "transportation", label: "Transportation needed", type: "enumeration", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
  { name: "start_datetime", label: "Start", type: "datetime", options: [] },
];

export function demoHubspotPrograms(q: HubspotProgramsScope): { programs: HubspotProgramRow[]; lineItems: HubspotLineItemRow[] } {
  const programs: HubspotProgramRow[] = [];
  const lineItems: HubspotLineItemRow[] = [];
  const types = ["field_trip", "overnight", "scout_day"];
  const scale = q.businessLine === "education" ? 1 : 0.3;
  for (let d = new Date(`${q.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= q.to; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const month = d.toISOString().slice(0, 10);
    const m = d.getUTCMonth();
    if (m === 6 || m === 7) continue;
    const period = month >= q.currentStart ? "current" : "previous";
    types.forEach((t, i) => {
      const deals = Math.max(1, Math.round((4 - i) * scale * (period === "current" ? 1.1 : 1) * (1 + (m % 3) * 0.2)));
      const per = [55, 140, 35][i]!;
      const participants = deals * [45, 30, 20][i]!;
      for (const atSamePoint of [true, false]) {
        const share = period === "previous" ? (atSamePoint ? 0.85 : 0.15) : atSamePoint ? 0 : 1;
        const n = Math.round(deals * share);
        if (!n) continue;
        programs.push({
          period,
          atSamePoint,
          month,
          programType: t,
          food: i === 1 ? "true" : i === 0 ? (m % 2 ? "true" : "false") : "false",
          transportation: i === 0 ? "yes" : "no",
          deals: n,
          revenue: Math.round(n * (participants / deals) * per),
          participants: Math.round(n * (participants / deals)),
          dealsWithParticipants: n,
          chaperones: Math.round(n * (participants / deals) / 10),
          dealsWithChaperones: n,
        });
      }
    });
  }
  for (const period of ["current", "previous"] as const) {
    for (const [item, price] of [["Program fee", 40], ["Lunch package", 12], ["Bus", 450], ["Overnight lodging", 85]] as const) {
      const quantity = period === "current" ? 900 : 820;
      const q2 = item === "Bus" ? Math.round(quantity / 50) : quantity;
      lineItems.push({ period, atSamePoint: period === "previous", item, quantity: q2, amount: q2 * price, deals: Math.round(q2 / 20) || 1 });
    }
  }
  return { programs, lineItems };
}
