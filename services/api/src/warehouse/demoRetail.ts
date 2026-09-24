import {
  addDays,
  comparisonRange,
  type InventoryResponse,
  type RetailBreakdownQuery,
  type RetailBreakdownResponse,
  type RetailBreakdownRow,
  type RetailKpiQuery,
  type RetailKpiResponse,
  type RetailLine,
} from "@dash/shared";
import { demoRow, noise } from "./demo.js";
import { toKpis } from "./retail.js";

/** Made-up catalog for local development only. */
interface DemoItem {
  item: string;
  variant: string;
  sku: string;
  category: string;
  weight: number;
  price: number;
}

const SHOPIFY_ITEMS: DemoItem[] = [
  { item: "Logo Hoodie", variant: "M / Navy", sku: "HD-NV-M", category: "Apparel", weight: 9, price: 58 },
  { item: "Logo Hoodie", variant: "L / Navy", sku: "HD-NV-L", category: "Apparel", weight: 7, price: 58 },
  { item: "Camp T-Shirt", variant: "Youth M", sku: "TS-Y-M", category: "Apparel", weight: 8, price: 24 },
  { item: "Camp T-Shirt", variant: "Adult L", sku: "TS-A-L", category: "Apparel", weight: 6, price: 26 },
  { item: "Water Bottle", variant: "Default Title", sku: "WB-01", category: "Gear", weight: 5, price: 22 },
  { item: "Trail Cap", variant: "Default Title", sku: "CP-01", category: "Accessories", weight: 4, price: 28 },
  { item: "Gift Card", variant: "$50", sku: "GC-50", category: "Gift Cards", weight: 3, price: 50 },
  { item: "Sticker Pack", variant: "Default Title", sku: "ST-05", category: "Accessories", weight: 2, price: 8 },
];

const SQUARE_ITEMS: DemoItem[] = [
  { item: "Latte", variant: "12 oz", sku: "BEV-LAT-12", category: "Coffee", weight: 10, price: 5.5 },
  { item: "Drip Coffee", variant: "Regular", sku: "BEV-DRP", category: "Coffee", weight: 8, price: 3 },
  { item: "Breakfast Sandwich", variant: "Regular", sku: "FD-BRK", category: "Food", weight: 7, price: 9 },
  { item: "Kayak Rental", variant: "1 hour", sku: "RN-KY-1", category: "Rentals", weight: 9, price: 35 },
  { item: "Paddleboard Rental", variant: "2 hours", sku: "RN-PB-2", category: "Rentals", weight: 6, price: 55 },
  { item: "Ice Cream", variant: "Single scoop", sku: "FD-IC-1", category: "Snacks", weight: 5, price: 4.5 },
  { item: "Sunscreen", variant: "Regular", sku: "RT-SUN", category: "Retail", weight: 2, price: 12 },
];

const SQUARE_LOCATIONS = ["Boathouse", "Marina Café", "North Beach", "Visitor Center", "Trailhead Kiosk", "Lodge Shop"];

interface DemoLine {
  date: string;
  orderKey: string;
  location: string | null;
  channel: string;
  it: DemoItem;
  quantity: number;
  gross: number;
  discounts: number;
}

function linesForDay(line: RetailLine, date: string): DemoLine[] {
  const day = demoRow(line, date, "booked");
  const items = line === "shopify" ? SHOPIFY_ITEMS : SQUARE_ITEMS;
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  const out: DemoLine[] = [];
  items.forEach((it, idx) => {
    const share = (it.weight / totalWeight) * (0.6 + 0.8 * noise(`${line}${date}${idx}`));
    const gross = day.gross * share;
    const quantity = Math.max(0, Math.round(gross / it.price));
    if (quantity === 0) return;
    const online = line === "shopify" && noise(`${date}${idx}ch`) < 0.65;
    const location =
      line === "shopify" ? (online ? null : "Main Street Shop") : SQUARE_LOCATIONS[Math.floor(noise(`${date}${idx}loc`) * SQUARE_LOCATIONS.length)]!;
    out.push({
      date,
      orderKey: `${date}-${idx}`,
      location,
      channel: line === "shopify" ? (online ? "Online Store" : "Point of Sale") : noise(`${date}${idx}src`) < 0.9 ? "Square Point of Sale" : "Square Online",
      it,
      quantity,
      gross: quantity * it.price,
      discounts: quantity * it.price * day.discounts / Math.max(day.gross, 1),
    });
  });
  return out;
}

function eachDay(start: string, end: string, fn: (d: string) => void) {
  for (let d = start; d <= end; d = addDays(d, 1)) fn(d);
}

export function demoRetailKpis(line: RetailLine, q: RetailKpiQuery): RetailKpiResponse {
  const cmp = comparisonRange({ start: q.start, end: q.end }, q.compare);
  const sum = (start: string, end: string) => {
    let orders = 0, units = 0, gross = 0, discounts = 0, refunds = 0, fees = 0;
    eachDay(start, end, (d) => {
      const row = demoRow(line, d, "booked");
      orders += row.transactions;
      refunds += row.refunds;
      fees += row.fees;
      for (const l of linesForDay(line, d)) {
        units += l.quantity;
        gross += l.gross;
        discounts += l.discounts;
      }
    });
    return toKpis({
      orders, units, gross, discounts, refunds, fees,
      tax: gross * 0.06,
      tips: line === "square" ? gross * 0.07 : 0,
      customers: Math.round(orders * 0.72),
    });
  };
  return {
    line,
    range: { start: q.start, end: q.end },
    comparisonRange: cmp,
    current: sum(q.start, q.end),
    comparison: cmp ? sum(cmp.start, cmp.end) : null,
  };
}

export function demoRetailBreakdown(line: RetailLine, q: RetailBreakdownQuery): RetailBreakdownResponse {
  const groups = new Map<string, RetailBreakdownRow & { orderKeys: Set<string> }>();
  eachDay(q.start, q.end, (d) => {
    for (const l of linesForDay(line, d)) {
      const key =
        q.dimension === "item" ? l.it.item
        : q.dimension === "variant" ? (["Default Title", "Regular"].includes(l.it.variant) ? l.it.item : `${l.it.item} — ${l.it.variant}`)
        : q.dimension === "category" ? l.it.category
        : q.dimension === "location" ? (l.location ?? "Online store")
        : l.channel;
      const detail = q.dimension === "item" ? l.it.category : q.dimension === "variant" ? l.it.sku : null;
      const g = groups.get(key) ?? { key, detail, orders: 0, units: 0, gross: 0, discounts: 0, net: 0, orderKeys: new Set() };
      g.orderKeys.add(l.orderKey);
      g.units += l.quantity;
      g.gross += l.gross;
      g.discounts += l.discounts;
      g.net = g.gross - g.discounts;
      groups.set(key, g);
    }
  });
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows = [...groups.values()]
    .map(({ orderKeys, ...r }) => ({
      ...r,
      // Each demo line stands for roughly 60% as many orders as units.
      orders: Math.max(orderKeys.size, Math.round(r.units * 0.6)),
      gross: round2(r.gross),
      discounts: round2(r.discounts),
      net: round2(r.net),
    }))
    .sort((a, b) => b.net - a.net);
  return {
    line,
    dimension: q.dimension,
    range: { start: q.start, end: q.end },
    rows: rows.slice(0, q.limit),
    truncated: rows.length > q.limit,
  };
}

export function demoShopifyInventory(): InventoryResponse {
  const rows = SHOPIFY_ITEMS.filter((i) => i.category !== "Gift Cards").flatMap((it, idx) =>
    ["Warehouse", "Main Street Shop"].map((location, li) => {
      const onHand = Math.round(noise(`inv${idx}${li}`) * 80);
      return {
        product: it.item,
        variant: it.variant === "Default Title" ? null : it.variant,
        sku: it.sku,
        location,
        onHand,
        available: Math.max(0, onHand - Math.round(noise(`res${idx}${li}`) * 5)),
      };
    }),
  );
  return { snapshotAt: new Date(Date.now() - 20 * 60_000).toISOString(), rows };
}
