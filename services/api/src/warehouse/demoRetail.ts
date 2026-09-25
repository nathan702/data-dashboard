import {
  addDays,
  comparisonRange,
  type BusinessLineOrUnassigned,
  type InventoryResponse,
  type RetailBreakdownQuery,
  type RetailBreakdownResponse,
  type RetailBreakdownRow,
  type RetailKpiQuery,
  type RetailKpiResponse,
  type RetailSource,
} from "@dash/shared";
import { DEMO_STREAMS, demoRow, noise, type DemoStream } from "./demo.js";
import { toKpis } from "./retail.js";

/** Made-up catalogs for local development only. */
interface DemoItem {
  item: string;
  variant: string;
  sku: string;
  category: string;
  weight: number;
  price: number;
}

const CATALOGS: Record<string, DemoItem[]> = {
  "shopify|river_store": [
    { item: "Logo Hoodie", variant: "M / Navy", sku: "HD-NV-M", category: "Apparel", weight: 9, price: 58 },
    { item: "Logo Hoodie", variant: "L / Navy", sku: "HD-NV-L", category: "Apparel", weight: 7, price: 58 },
    { item: "River T-Shirt", variant: "Adult L", sku: "TS-A-L", category: "Apparel", weight: 8, price: 26 },
    { item: "Dry Bag", variant: "10L", sku: "DB-10", category: "Gear", weight: 5, price: 32 },
    { item: "Water Bottle", variant: "Default Title", sku: "WB-01", category: "Gear", weight: 4, price: 22 },
    { item: "Gift Card", variant: "$50", sku: "GC-50", category: "Gift Cards", weight: 3, price: 50 },
  ],
  "square|farm_store": [
    { item: "Farm Eggs", variant: "Dozen", sku: "FS-EGG-12", category: "Dairy & Eggs", weight: 9, price: 7 },
    { item: "Seasonal Produce Box", variant: "Regular", sku: "FS-BOX", category: "Produce", weight: 8, price: 28 },
    { item: "Local Honey", variant: "12 oz", sku: "FS-HNY", category: "Pantry", weight: 5, price: 14 },
    { item: "Apple Cider Donuts", variant: "Half dozen", sku: "FS-DON-6", category: "Bakery", weight: 7, price: 9 },
    { item: "Flowers", variant: "Bouquet", sku: "FS-FLW", category: "Flowers", weight: 3, price: 18 },
  ],
  "square|events": [
    { item: "Wood-fired Pizza", variant: "Margherita", sku: "EV-PZ-M", category: "Food", weight: 10, price: 16 },
    { item: "Wood-fired Pizza", variant: "Pepperoni", sku: "EV-PZ-P", category: "Food", weight: 8, price: 18 },
    { item: "Local Beer", variant: "Draft", sku: "EV-BEER", category: "Beverages", weight: 7, price: 8 },
    { item: "Lemonade", variant: "Regular", sku: "EV-LEM", category: "Beverages", weight: 4, price: 4 },
  ],
  "square|haunted_forest": [
    { item: "Hot Cider", variant: "Regular", sku: "HF-CID", category: "Beverages", weight: 9, price: 5 },
    { item: "Kettle Corn", variant: "Large", sku: "HF-KC-L", category: "Snacks", weight: 7, price: 8 },
    { item: "Glow Stick", variant: "Regular", sku: "HF-GLOW", category: "Merchandise", weight: 3, price: 4 },
    { item: "Fast Pass Upgrade", variant: "Regular", sku: "HF-FAST", category: "Upgrades", weight: 4, price: 15 },
  ],
};

const LOCATIONS: Record<string, string[]> = {
  "square|farm_store": ["Farm Store"],
  "square|events": ["Events", "Pizza Nights"],
  "square|haunted_forest": ["MHF"],
};

interface DemoLine {
  orderKey: string;
  location: string | null;
  channel: string;
  it: DemoItem;
  quantity: number;
  gross: number;
  discounts: number;
}

function streamsFor(source: RetailSource, businessLine: BusinessLineOrUnassigned | undefined): DemoStream[] {
  return DEMO_STREAMS.filter((s) => s.source === source && (!businessLine || s.businessLine === businessLine));
}

function linesForDay(s: DemoStream, date: string): DemoLine[] {
  const key = `${s.source}|${s.businessLine}`;
  const items = CATALOGS[key] ?? [];
  const day = demoRow(s, date, "booked");
  const totalWeight = items.reduce((t, i) => t + i.weight, 0);
  const out: DemoLine[] = [];
  items.forEach((it, idx) => {
    const share = (it.weight / totalWeight) * (0.6 + 0.8 * noise(`${key}${date}${idx}`));
    const quantity = Math.max(0, Math.round((day.gross * share) / it.price));
    if (quantity === 0) return;
    const online = s.source === "shopify" && noise(`${date}${idx}ch`) < 0.65;
    const locs = LOCATIONS[key];
    out.push({
      orderKey: `${key}${date}-${idx}`,
      location: s.source === "shopify" ? (online ? null : "River Store") : locs![Math.floor(noise(`${date}${idx}loc`) * locs!.length)]!,
      channel: s.source === "shopify" ? (online ? "Online Store" : "Point of Sale") : noise(`${date}${idx}src`) < 0.8 ? "Point of Sale" : "Kiosk",
      it,
      quantity,
      gross: quantity * it.price,
      discounts: (quantity * it.price * day.discounts) / Math.max(day.gross, 1),
    });
  });
  return out;
}

function eachDay(start: string, end: string, fn: (d: string) => void) {
  for (let d = start; d <= end; d = addDays(d, 1)) fn(d);
}

export function demoRetailKpis(source: RetailSource, q: RetailKpiQuery): RetailKpiResponse {
  const cmp = comparisonRange({ start: q.start, end: q.end }, q.compare);
  const streams = streamsFor(source, q.businessLine);
  const sum = (start: string, end: string) => {
    let orders = 0, units = 0, gross = 0, discounts = 0, refunds = 0, fees = 0;
    eachDay(start, end, (d) => {
      for (const s of streams) {
        const row = demoRow(s, d, "booked");
        orders += row.transactions;
        refunds += row.refunds;
        fees += row.fees;
        for (const l of linesForDay(s, d)) {
          units += l.quantity;
          gross += l.gross;
          discounts += l.discounts;
        }
      }
    });
    return toKpis({
      orders, units, gross, discounts, refunds, fees,
      tax: gross * 0.06,
      tips: source === "square" ? gross * 0.05 : 0,
      customers: Math.round(orders * 0.72),
    });
  };
  return {
    source,
    businessLine: q.businessLine ?? null,
    range: { start: q.start, end: q.end },
    comparisonRange: cmp,
    current: sum(q.start, q.end),
    comparison: cmp ? sum(cmp.start, cmp.end) : null,
  };
}

export function demoRetailBreakdown(source: RetailSource, q: RetailBreakdownQuery): RetailBreakdownResponse {
  const groups = new Map<string, RetailBreakdownRow & { orderKeys: Set<string> }>();
  const streams = streamsFor(source, q.businessLine);
  eachDay(q.start, q.end, (d) => {
    for (const s of streams) {
      for (const l of linesForDay(s, d)) {
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
    }
  });
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows = [...groups.values()]
    .map(({ orderKeys, ...r }) => ({
      ...r,
      orders: Math.max(orderKeys.size, Math.round(r.units * 0.6)),
      gross: round2(r.gross),
      discounts: round2(r.discounts),
      net: round2(r.net),
    }))
    .sort((a, b) => b.net - a.net);
  return {
    source,
    businessLine: q.businessLine ?? null,
    dimension: q.dimension,
    range: { start: q.start, end: q.end },
    rows: rows.slice(0, q.limit),
    truncated: rows.length > q.limit,
  };
}

export function demoShopifyInventory(): InventoryResponse {
  const rows = (CATALOGS["shopify|river_store"] ?? [])
    .filter((i) => i.category !== "Gift Cards")
    .flatMap((it, idx) =>
      ["Warehouse", "River Store"].map((location, li) => {
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
