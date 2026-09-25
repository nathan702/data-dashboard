/**
 * Staging models that feed marts.fct_revenue_daily. Each phase adds its
 * source's model here. Every model must output exactly these columns:
 *
 *   source        STRING   -- 'shopify' | 'square' | 'hubspot' | 'campminder' | 'fareharbor'
 *   assign_key    STRING   -- the value business lines are assigned by (Square location id,
 *                             Campminder session, ...); see marts.business_line_assignments
 *   revenue_date  DATE     -- Eastern-time calendar date
 *   date_basis    STRING   -- 'booked' | 'collected' | 'service'
 *   location      STRING   -- store / Square location / NULL
 *   channel       STRING   -- e.g. 'online', 'pos', pipeline name / NULL
 *   gross, discounts, refunds, fees  NUMERIC  -- USD; normally positive (refunds and
 *                                     discounts are amounts subtracted, not negatives)
 *   transactions  INT64
 */
const revenueSources = ["stg_shopify_revenue_daily", "stg_square_revenue_daily"];

module.exports = { revenueSources };
