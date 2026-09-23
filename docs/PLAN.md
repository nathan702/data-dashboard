# Plan

Internal dashboards for leadership and business-line managers (~10 people)
covering five business lines. Each line is reported separately; the Overview
page shows them side by side.

## Decisions

| Topic | Decision |
|---|---|
| Users & access | ~10 people, everyone sees everything. Google Workspace sign-in, domain-restricted, optional allow-list in Firestore `config/access`. |
| Dashboards | Pre-built, custom React app with heavy sorting/filtering, CSV export, shareable filtered URLs. |
| Hosting | New Firebase / Google Cloud project. Target < $50/month (expected $0–15). |
| Maintenance | Hands-off: managed services only, failure alerts, status page. |
| Freshness | Per source: seconds (Shopify, Square, HubSpot webhooks), as often as practical for Campminder/FareHarbor. |
| History | Everything each platform can provide. |
| Time zone | US Eastern for all reporting dates. |
| Seasons | Campminder season *Y* = day after camp ends in *Y*-1 through end of summer *Y*. Cutover configurable (default Sep 1). |
| Revenue options | Count by booked / paid / activity date; measure gross / net / net after fees. All selectable in the UI. |
| Privacy | No names, emails, phones or medical data stored. People are counted via keyed hashes. Campminder keeps non-identifying fields: age, grade, gender, new vs returning. |
| Notifications | Daily/weekly digests and alerts to both Slack and email. |
| Budgets/targets | Later, via a Google Sheet read directly by BigQuery. |
| Future sources | Connector framework makes each new source one module (e.g. QuickBooks, Google Analytics, payroll, Ramp). |

## Architecture

```
 Shopify ─┐ webhooks + 15-min polls        ┌────────────────────────────┐
 Square  ─┼──────────────────────────────▶ │ Cloud Run: connectors      │
 HubSpot ─┘                                 │  • jobs (private, Scheduler)│
 Campminder automation ─▶ Cloud Storage ──▶ │  • webhooks (public, signed)│
 FareHarbor emails ─▶ Gmail ──────────────▶ └──────────┬─────────────────┘
                                                       │ raw JSON rows
                                            BigQuery raw_<source>.*
                                                       │ Dataform (SQL, scheduled)
                                            staging.* → marts.*
                                                       │
 Browser (React, Firebase Hosting) ──/api──▶ Cloud Run: API ──▶ BigQuery marts
        Google sign-in (Firebase Auth)            │
                                            Firestore: sync_state, config/access
```

- **Raw layer** (`raw_<source>.<entity>`): what the platform sent, one row per
  version, payload as JSON. Tables are created automatically on first write.
- **Staging** (`staging.*`): latest version per record, typed, Eastern dates.
- **Marts** (`marts.*`): what the dashboards read. `fct_revenue_daily` is the
  shared contract for the Overview page; each line also gets its own tables.
- **Sync state** (Firestore `sync_state/{source}`): cursors and freshness,
  shown as "updated N seconds ago" in the app.

## Data model (marts)

Shared: `dim_date` (calendar, week, season), `fct_revenue_daily` (line × date ×
basis × location × channel: gross, discounts, refunds, fees, transactions).

| Line | Tables |
|---|---|
| Campminder | `cm_enrollments`, `cm_sessions` (capacity, enrolled, waitlist, utilization), `cm_payments`, `cm_balances` — all by season |
| FareHarbor | `fh_bookings` (item, booked/activity dates, headcount by customer type, gross/net, status, channel/affiliate), `fh_cancellations` |
| HubSpot | `hs_deals` (pipeline, stage, amount, owner, dates), `hs_deal_stage_history`, `hs_payments` |
| Shopify | `sh_orders`, `sh_order_lines`, `sh_refunds`, `sh_discounts`, `sh_inventory_daily`, `sh_products` (online vs POS) |
| Square | `sq_orders`, `sq_line_items` (item, category, location), `sq_payments` (tips, fees), `sq_refunds`, `sq_catalog` |

## Source connections

| Source | Method | Freshness | History |
|---|---|---|---|
| Shopify | Admin API custom-app token; webhooks for orders/refunds/products/inventory + 15-min reconciliation | Seconds | GraphQL bulk export |
| Square | Access token; webhooks for payments/orders/refunds + 15-min reconciliation; catalog nightly | Seconds | Orders/Payments search |
| HubSpot | Private-app token; webhooks for deals + 15-min polls of deals, stage history, payments | Seconds–minutes | Full CRM export |
| Campminder | Existing Cloud automation writes its report to a Cloud Storage bucket; an upload triggers import with PII allow-listing | Each automation run | Depends on past-season exports |
| FareHarbor | No API. Booking notification emails to a dedicated Workspace mailbox, read via the Gmail API (push via Pub/Sub). One-time CSV export for history. | ~1 minute | Manual export |

FareHarbor limitation: notification emails carry bookings, changes and
cancellations, but not slot capacity, so utilization needs either capacity
entered per item or a periodic dashboard export. Decide in Phase 5.

## Phases

1. **Foundation** ✅ project scaffold, connector framework, API with Google
   sign-in, dashboard shell (Overview, per-line pages, Status), `dim_date` with
   seasons, `fct_revenue_daily` contract, deploy scripts, CI.
2. **Shopify + Square**: webhooks, reconciliation, backfill, staging/marts, dashboards.
3. **HubSpot**: deals, stage history, payments, pipeline dashboards.
4. **Campminder**: hook up the existing automation, PII allow-list, season dashboards.
5. **FareHarbor**: Gmail ingestion, email parser, historical import, dashboards.
6. **Summary & extras**: digests and alerts (Slack + email), polish.

## Open items

- **Campminder** (before Phase 4): output file format and columns, how often it
  runs, whether it can also export payments/sessions/balances and past seasons,
  and a sample with personal details removed.
- **FareHarbor** (before Phase 5): which mailbox receives booking notifications
  and a few sample emails (new, changed, cancelled).
- **Freshness vs cost** (Phase 2): with real volumes, choose between frequent
  incremental Dataform runs and views for recent days. Target stays < $50/month.
- **Slack**: which workspace/channel for digests (Phase 6).
