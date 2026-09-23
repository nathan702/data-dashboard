/**
 * Staging models that feed marts.fct_revenue_daily. Each phase adds its
 * source's model here. Every model must output exactly these columns:
 *
 *   business_line STRING   -- 'shopify' | 'square' | 'hubspot' | 'campminder' | 'fareharbor'
 *   revenue_date  DATE     -- Eastern-time calendar date
 *   date_basis    STRING   -- 'booked' | 'collected' | 'service'
 *   location      STRING   -- store / Square location / NULL
 *   channel       STRING   -- e.g. 'online', 'pos', pipeline name / NULL
 *   gross, discounts, refunds, fees  NUMERIC  -- positive amounts, USD
 *   transactions  INT64
 */
const revenueSources = [];

module.exports = { revenueSources };
