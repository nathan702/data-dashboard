import { useState } from "react";
import {
  RETAIL_DIMENSION_LABEL,
  RETAIL_LINE_DIMENSIONS,
  type InventoryRow,
  type RetailBreakdownRow,
  type RetailDimension,
  type RetailKpis,
  type RetailLine,
} from "@dash/shared";
import { useRetailBreakdown, useRetailKpis, useShopifyInventory } from "../lib/api";
import { LINE_COLOR_VAR } from "../lib/colors";
import { useFilters } from "../lib/filters";
import { formatInt, formatPercent, formatUsd, percentChange, timeAgo } from "../lib/format";
import { DataTable, type Column } from "./DataTable";
import { TopBarChart } from "./TopBarChart";

type KpiKey = keyof RetailKpis;

const KPI_TILES: Record<RetailLine, Array<{ key: KpiKey; label: string; money: boolean; upIsGood?: boolean }>> = {
  shopify: [
    { key: "orders", label: "Orders", money: false },
    { key: "units", label: "Units sold", money: false },
    { key: "averageOrderValue", label: "Avg order value", money: true },
    { key: "customers", label: "Customers", money: false },
    { key: "discounts", label: "Discounts", money: true, upIsGood: false },
    { key: "refunds", label: "Refunds", money: true, upIsGood: false },
    { key: "fees", label: "Fees", money: true, upIsGood: false },
  ],
  square: [
    { key: "orders", label: "Orders", money: false },
    { key: "units", label: "Units sold", money: false },
    { key: "averageOrderValue", label: "Avg order value", money: true },
    { key: "tips", label: "Tips", money: true },
    { key: "discounts", label: "Discounts", money: true, upIsGood: false },
    { key: "refunds", label: "Refunds", money: true, upIsGood: false },
    { key: "fees", label: "Fees", money: true, upIsGood: false },
  ],
};

function KpiTile({ label, value, previous, money, upIsGood = true, cmpLabel }: {
  label: string;
  value: number;
  previous: number | null;
  money: boolean;
  upIsGood?: boolean;
  cmpLabel: string | null;
}) {
  const change = percentChange(value, previous);
  const dir = change === null || Math.abs(change) < 0.0005 ? "flat" : change > 0 ? "up" : "down";
  const good = dir === "flat" ? "flat" : (dir === "up") === upIsGood ? "up" : "down";
  return (
    <div className="tile tile-small">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{money ? formatUsd(value) : formatInt(Math.round(value))}</div>
      {cmpLabel && (
        <div className={`tile-delta delta-${good}`}>
          {dir !== "flat" && <span aria-hidden>{dir === "up" ? "▲ " : "▼ "}</span>}
          {formatPercent(change)} <span className="muted">vs {cmpLabel}</span>
        </div>
      )}
    </div>
  );
}

/** Order-level KPIs and item/category/location/channel breakdowns for Shopify and Square. */
export function RetailDetail({ line }: { line: RetailLine }) {
  const [filters] = useFilters();
  const dims = RETAIL_LINE_DIMENSIONS[line];
  const [dimension, setDimension] = useState<RetailDimension>(dims[0]!);
  const kpis = useRetailKpis(line, { start: filters.start, end: filters.end, compare: filters.compare });
  const breakdown = useRetailBreakdown(line, { start: filters.start, end: filters.end, dimension });
  const cmpLabel = filters.compare === "none" ? null : filters.compare === "previous_year" ? "last year" : "previous period";

  const columns: Column<RetailBreakdownRow>[] = [
    { key: "key", label: RETAIL_DIMENSION_LABEL[dimension], value: (r) => r.key },
    ...(dimension === "item"
      ? [{ key: "detail", label: "Category", value: (r: RetailBreakdownRow) => r.detail }]
      : dimension === "variant"
        ? [{ key: "detail", label: "SKU", value: (r: RetailBreakdownRow) => r.detail }]
        : []),
    { key: "orders", label: "Orders", numeric: true, value: (r) => r.orders, render: (r) => formatInt(r.orders) },
    { key: "units", label: "Units", numeric: true, value: (r) => r.units, render: (r) => formatInt(Math.round(r.units)) },
    { key: "gross", label: "Gross", numeric: true, value: (r) => r.gross, render: (r) => formatUsd(r.gross) },
    { key: "discounts", label: "Discounts", numeric: true, value: (r) => r.discounts, render: (r) => formatUsd(r.discounts) },
    { key: "net", label: "Net", numeric: true, value: (r) => r.net, render: (r) => formatUsd(r.net) },
  ];
  const totalNet = (breakdown.data?.rows ?? []).reduce((s, r) => s + r.net, 0);
  columns.push({
    key: "share",
    label: "Share of net",
    numeric: true,
    value: (r) => (totalNet ? r.net / totalNet : null),
    render: (r) => (totalNet ? `${((r.net / totalNet) * 100).toFixed(1)}%` : "–"),
  });

  return (
    <section className="page-section" aria-label="Sales detail">
      <h2 className="section-title">Sales detail</h2>
      {kpis.error && <div className="error-banner">Couldn't load order stats: {kpis.error.message}</div>}
      {kpis.data && (
        <div className={`tiles${kpis.isPlaceholderData ? " refetching" : ""}`}>
          {KPI_TILES[line].map((t) => (
            <KpiTile
              key={t.key}
              label={t.label}
              money={t.money}
              upIsGood={t.upIsGood}
              value={kpis.data.current[t.key]}
              previous={kpis.data.comparison ? kpis.data.comparison[t.key] : null}
              cmpLabel={kpis.data.comparison ? cmpLabel : null}
            />
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Net sales by {RETAIL_DIMENSION_LABEL[dimension].toLowerCase()} (top 10)</h3>
          <div className="segmented" role="tablist" aria-label="Break down by">
            {dims.map((d) => (
              <button key={d} type="button" role="tab" aria-selected={d === dimension} onClick={() => setDimension(d)}>
                {RETAIL_DIMENSION_LABEL[d]}
              </button>
            ))}
          </div>
        </div>
        {breakdown.error && <div className="error-banner">Couldn't load breakdown: {breakdown.error.message}</div>}
        {breakdown.data && (
          <div className={breakdown.isPlaceholderData ? "refetching" : undefined}>
            <TopBarChartSection rows={breakdown.data.rows} color={LINE_COLOR_VAR[line]} />
          </div>
        )}
      </div>

      {breakdown.data && (
        <DataTable
          caption={`All ${RETAIL_DIMENSION_LABEL[dimension].toLowerCase()} rows${breakdown.data.truncated ? " (top 1,000)" : ""}`}
          rows={breakdown.data.rows}
          columns={columns}
          rowKey={(r) => r.key}
          exportName={`${line}_${dimension}_${filters.start}_${filters.end}`}
        />
      )}

      {line === "shopify" && <InventoryTable />}
    </section>
  );
}

function TopBarChartSection({ rows, color }: { rows: RetailBreakdownRow[]; color: string }) {
  return <TopBarChart rows={rows.slice(0, 10).map((r) => ({ key: r.key, value: r.net }))} color={color} valueLabel="net sales" />;
}

const LOW_STOCK = 5;

function InventoryTable() {
  const { data, error } = useShopifyInventory();
  const [lowOnly, setLowOnly] = useState(false);
  if (error) return <div className="error-banner">Couldn't load inventory: {error.message}</div>;
  if (!data) return null;
  const rows = lowOnly ? data.rows.filter((r) => r.available <= LOW_STOCK) : data.rows;
  return (
    <div className="inventory">
      <div className="inventory-header">
        <h2 className="section-title">Inventory</h2>
        <span className="freshness-note">Snapshot {timeAgo(data.snapshotAt)} · current stock, not affected by the date filter</span>
        <label className="checkbox">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low stock only (≤ {LOW_STOCK})
        </label>
      </div>
      <DataTable<InventoryRow>
        rows={rows}
        rowKey={(r) => `${r.sku ?? r.product}|${r.variant ?? ""}|${r.location}`}
        exportName="shopify_inventory"
        columns={[
          { key: "product", label: "Product", value: (r) => r.product },
          { key: "variant", label: "Variant", value: (r) => r.variant },
          { key: "sku", label: "SKU", value: (r) => r.sku },
          { key: "location", label: "Location", value: (r) => r.location },
          {
            key: "available",
            label: "Available",
            numeric: true,
            value: (r) => r.available,
            render: (r) => <span className={r.available <= LOW_STOCK ? "low-stock" : undefined}>{formatInt(r.available)}</span>,
          },
          { key: "onHand", label: "On hand", numeric: true, value: (r) => r.onHand, render: (r) => formatInt(r.onHand) },
        ]}
      />
    </div>
  );
}
