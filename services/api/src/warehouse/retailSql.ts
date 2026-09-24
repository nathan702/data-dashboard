import type { RetailDimension } from "@dash/shared";

/**
 * SQL for the retail (Shopify, Square) endpoints. Only these fixed strings
 * are interpolated; request values are always query parameters.
 */
export const DIMENSION_SQL: Record<RetailDimension, { key: string; detail: string }> = {
  item: { key: "COALESCE(item_name, 'Unnamed item')", detail: "ANY_VALUE(category)" },
  variant: {
    key: "CONCAT(COALESCE(item_name, 'Unnamed item'), IF(COALESCE(variant_name, '') IN ('', 'Default Title', 'Regular'), '', CONCAT(' — ', variant_name)))",
    detail: "ANY_VALUE(sku)",
  },
  category: { key: "COALESCE(NULLIF(category, ''), 'Uncategorized')", detail: "CAST(NULL AS STRING)" },
  location: {
    key: "COALESCE(location, IF(business_line = 'shopify', 'Online store', 'Unknown location'))",
    detail: "CAST(NULL AS STRING)",
  },
  channel: { key: "COALESCE(NULLIF(channel, ''), 'Other')", detail: "CAST(NULL AS STRING)" },
};

export function kpiSql(dataset: string) {
  return `
    WITH orders AS (
      SELECT
        IF(sale_date BETWEEN @start AND @end, 'current', 'comparison') AS period,
        COUNT(DISTINCT order_id) AS orders,
        SUM(units) AS units, SUM(gross) AS gross, SUM(discounts) AS discounts,
        SUM(tax) AS tax, SUM(tips) AS tips, SUM(fees) AS fees,
        COUNT(DISTINCT customer_hash) AS customers
      FROM \`${dataset}.fct_retail_orders\`
      WHERE business_line = @line
        AND (sale_date BETWEEN @start AND @end OR (@has_cmp AND sale_date BETWEEN @cmp_start AND @cmp_end))
      GROUP BY 1
    ),
    refunds AS (
      -- Refunds are counted on the day they happen, as in the revenue view.
      SELECT
        IF(revenue_date BETWEEN @start AND @end, 'current', 'comparison') AS period,
        SUM(refunds) AS refunds
      FROM \`${dataset}.fct_revenue_daily\`
      WHERE business_line = @line AND date_basis = 'booked'
        AND (revenue_date BETWEEN @start AND @end OR (@has_cmp AND revenue_date BETWEEN @cmp_start AND @cmp_end))
      GROUP BY 1
    )
    SELECT
      period,
      COALESCE(o.orders, 0) AS orders, COALESCE(o.units, 0) AS units,
      COALESCE(o.gross, 0) AS gross, COALESCE(o.discounts, 0) AS discounts,
      COALESCE(o.tax, 0) AS tax, COALESCE(o.tips, 0) AS tips, COALESCE(o.fees, 0) AS fees,
      COALESCE(o.customers, 0) AS customers, COALESCE(r.refunds, 0) AS refunds
    FROM UNNEST(['current', 'comparison']) AS period
    LEFT JOIN orders AS o USING (period)
    LEFT JOIN refunds AS r USING (period)`;
}

export function breakdownSql(dataset: string, dimension: RetailDimension) {
  const d = DIMENSION_SQL[dimension];
  return `
    SELECT
      ${d.key} AS key,
      ${d.detail} AS detail,
      COUNT(DISTINCT order_id) AS orders,
      SUM(quantity) AS units,
      SUM(gross) AS gross,
      SUM(discounts) AS discounts,
      SUM(gross - discounts) AS net
    FROM \`${dataset}.fct_retail_line_items\`
    WHERE business_line = @line AND sale_date BETWEEN @start AND @end
    GROUP BY 1
    ORDER BY net DESC, key
    LIMIT @limit_plus_one`;
}

export function inventorySql(dataset: string) {
  return `
    SELECT product, variant, sku, location, available, on_hand, snapshot_at
    FROM \`${dataset}.shopify_inventory_current\`
    ORDER BY product, variant, location`;
}
