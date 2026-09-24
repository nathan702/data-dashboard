import type { RetailKpis } from "@dash/shared";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build the KPI object from summed components; net and AOV are derived the same way everywhere. */
export function toKpis(r: {
  orders?: number | string | null;
  units?: number | string | null;
  gross?: number | string | null;
  discounts?: number | string | null;
  refunds?: number | string | null;
  tax?: number | string | null;
  tips?: number | string | null;
  fees?: number | string | null;
  customers?: number | string | null;
}): RetailKpis {
  const n = (v: number | string | null | undefined) => Number(v ?? 0);
  const orders = n(r.orders);
  const net = n(r.gross) - n(r.discounts) - n(r.refunds);
  return {
    orders,
    units: round2(n(r.units)),
    gross: round2(n(r.gross)),
    discounts: round2(n(r.discounts)),
    refunds: round2(n(r.refunds)),
    net: round2(net),
    tax: round2(n(r.tax)),
    tips: round2(n(r.tips)),
    fees: round2(n(r.fees)),
    averageOrderValue: orders > 0 ? round2(net / orders) : 0,
    customers: n(r.customers),
  };
}
