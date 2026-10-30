# Plan

Internal dashboards for leadership and business-line managers (~10 people),
organized by **business line**, with a report builder for questions the
dashboards don't answer directly. Live at <https://data.calleva.org>
(also <https://calleva-dashboard.web.app>).

This file is the source of truth for what's decided, what's built, and what
comes next, in order. Setup and operating steps are in `SETUP.md`.

## Decisions

| Topic | Decision |
|---|---|
| Users & access | ~10 people, everyone sees everything. Google Workspace sign-in, domain-restricted, optional allow-list and admin list in Firestore `config/access`. |
| Dashboards | Pre-built pages per business line with filtering, drill-down, CSV export and shareable URLs, plus a self-serve **report builder**. |
| AI | **No AI inside the app.** Questions the builder can't answer go to the developer (Claude, outside the app), who adds fields, measures or starter reports. |
| Hosting | Firebase / Google Cloud project `calleva-dashboard`. Target < $50/month. |
| Maintenance | Hands-off: managed services only, status page. Every change is a GitHub pull request; merging it into `main` deploys it automatically, with a live self-check. Undo = revert the pull request. |
| Freshness | Square/Shopify webhooks land in seconds; dashboards rebuild every 15 minutes. Campminder sheet checked hourly (it changes daily). |
| History | Everything each platform can provide. Campminder 2022 onward (history sheet) plus the daily sheet. |
| Time zone | US Eastern for all reporting dates. |
| Dates | Revenue counts by **program / service date** by default (when things happen); booked and paid dates are selectable. |
| Seasons | Set per business line on Settings → Seasons: calendar year (Camp, River School, Events, CHAPs, Education, both stores), Campminder season (School Year Programs), or an end date set each year (Haunted Forest: Nov 8 in 2026). Campminder's own seasons start on Labor Day, overridable per year. |
| Comparisons | Same dates last year, same weekdays last year (default on Events and Haunted Forest), or previous period. |
| Privacy | No names, emails, phones, street addresses or medical data in the warehouse; people are keyed hashes (stable across seasons). Campminder keeps age, grades, gender, years at camp, state, ZIP and (by decision) exact home coordinates for the family map; addresses are geocoded once and never stored. Individual campers may appear in reports as scrambled IDs. |
| Notifications | Daily/weekly digests and alerts to Slack and email (later). |
| Domain | `data.calleva.org` for this app. Future intranet at `tools.calleva.org` (see roadmap). |

## Business lines

Reporting is organized by business line, not platform. Each platform's records
are split across lines by assignments on **Settings** (admins); anything
unmatched is "Unassigned" and flagged.

| Business line | Platforms | Split by | Season |
|---|---|---|---|
| Camp | Campminder | Session group | Calendar year (summer camps of that year) |
| River School | FareHarbor | FareHarbor dashboard | Calendar year |
| Events | FareHarbor + Square food & beverage | Dashboard; Square locations | Calendar year |
| Haunted Forest | FareHarbor + Square food & beverage | Dashboard; Square location "MHF" | Ends on a date set each year |
| CHAPs | Campminder individual programs + HubSpot group bookings | Session group; pipeline | Calendar year |
| Education Programs | HubSpot | Pipeline | Calendar year |
| School Year Programs | Campminder | Session group | Campminder season |
| River Store | Shopify | Whole store | Calendar year |
| Farm Store | Square | Location "Farm Store" | Calendar year |

## Architecture

```
 Square  ─┐ webhooks + 15-min syncs         ┌─────────────────────────────┐
 Shopify ─┤                                  │ Cloud Run: connectors       │
 Campminder report ─▶ Google Sheet (daily) ─▶│  • jobs (private, Scheduler)│
 Campminder history ─▶ Google Sheet (tabs) ─▶│  • webhooks (public, signed)│
 FareHarbor (planned) webhooks + API ───────▶└──────────┬──────────────────┘
                     US Census geocoder ◀── home addresses (once each, cached)
                                                        │ raw JSON rows
                                             BigQuery raw_<source>.*
                                                        │ Dataform SQL, Cloud Run job every 15 min
                                             staging.* → marts.*
                                                        │
 Browser (React, Firebase Hosting) ──/api──▶ Cloud Run: API ──▶ BigQuery marts
        Google sign-in (Firebase Auth)          │
                                  Firestore: sync state, settings, saved reports
```

- **Raw** (`raw_<source>.<entity>`): what the platform sent, one row per version.
- **Staging / marts**: latest state, typed, Eastern dates. Main marts:
  `fct_revenue_daily`, `fct_retail_orders`, `fct_retail_line_items`,
  `shopify_inventory_current`, `fct_campminder_enrollments`,
  `business_line_assignments`.
- **Report builder data sets** (enrollments, campers by season, campers by
  program family, revenue, store sales) are computed at query time from the
  marts, so they need no extra tables.
- **Firestore**: sync state and cursors, `config/access`, `config/seasons`,
  `config/programFamilies`, `config/schools`, saved `reports`, per-person tab order, and the
  geocode cache (`campminder_geocodes`, not readable from the app).
- **Deploys**: every push to the branch deploys automatically; a self-check
  compares the API's numbers with plain table totals (revenue, store sales,
  drill-down filters, Campminder enrollments, every starter report) and fails
  the deploy if they disagree.

## Built so far

- **Foundation**: Google sign-in, business-line tabs (customizable per person),
  Settings, Data status, automatic deploys with self-check.
- **Square** (live) and **Shopify** (built; paused waiting on credentials):
  revenue, order KPIs, breakdowns, inventory, with click-to-filter drill-down
  (category → item → variant, location → channel → category).
- **Campminder** (live): daily sheet + 2022–2025 history; enrollments, campers
  per week, sign-up pace against last season, breakdowns with stackable
  drill-down filters, family map with exact home locations.
- **Seasons per business line**, same-weekday comparisons, service-date default.
- **Report builder** (Reports tab): five data sets, vetted fields and measures,
  rows/columns/measure/filters, table, bar, line and heat map, click-to-filter,
  private or shared saved reports, six starter reports (sessions by years at
  camp, sessions by session group, Explorers branches, ZIP by week, schools,
  retention). Campers by season can be filtered or grouped by the session
  groups, sessions, programs and weeks they attended, with sessions counted
  in just those groups, returns to the same session group, other business
  lines the same season and cancellations; enrollments by sign-up month and
  weeks ahead. Any filter can leave values out instead ("everything except"),
  and tables can show the change from the previous season, month or week.
  Program families and schools on Settings.
- **Camper schools**: imported as entered and matched to actual schools
  (official directory or added on Settings) with typo-, abbreviation- and
  initials-tolerant matching; a review list for the unsure ones; School,
  School type, state and county in reports; School breakdown and filter on
  the Camp pages.
- **Parent occupations**: each parent's occupation (up to four, both
  households) sorted into one of 15 categories on import; only the category
  is kept. Parent occupation in reports; breakdown and filter on the Camp
  pages.
- **Settings tabs**: one tab per platform's assignments, Seasons, Program
  families, Schools.

## Roadmap (in order)

1. ~~Seasons per business line~~ ✅
2. ~~Advanced analysis and drill-down~~ ✅ report builder, starter reports, store
   drill-down. FareHarbor and HubSpot get the same drill-down when connected.
3. **Camper schools** ✅ The school is imported as entered and matched to the
   official U.S. Department of Education school list (DC, MD, VA) or a school
   added on Settings → Schools: confident matches (≥ 90%) automatically, the
   rest grouped in a review list. Reports get School, School type, state and
   county; the Camp pages break down and filter by school. Answers marked
   "not a school" are kept out of the data. *Needs:* 2022–2025 history
   re-exported with the School column.
4. **Parent occupations** ✅ Each parent's occupation (F1P1–F2P2 columns) is
   sorted into one of 15 categories ("attorney" / "lawyer" → Legal) when
   imported; the text itself is never stored. Everyone can see it.
5. **Campminder financials** ← *next*: from the separate report produced by the other
   Google Cloud project, read the same way as the daily sheet.
6. **Family and sibling reporting**: keep the household ID as a scrambled ID;
   sibling status week by week.
7. **Registration open dates**: returning MD families, returning VA families and
   new families, set per year; pace charts align by days since opening.
8. **Decision-making features**: forecasts and behind-pace alerts, capacity and
   waitlists, returning families not yet re-enrolled, campers per age group per
   week (staffing), where new families come from, weekly email/Slack digest,
   revenue per camper.
9. **Test and live separation**: a second website (`…-test`) in the same Google
   Cloud project, reading the same raw data into its own tables; changes deploy
   to test first and are promoted to live.
10. **Merged customer database + email sync** (Emma today; the tool may change):
    read-only, rebuilt from the source systems, in BigQuery in its own
    access-restricted dataset. Matching: email, then phone, then standardized
    address + last name (apartment numbers must match); people and households as
    separate layers; "always/never merge" rules only if needed; preview matches
    before turning it on. The email tool holds subscription status and the sync
    never re-adds unsubscribes. Lookups ~1–2 s, audience searches ~1–5 s.
11. **Intranet with single sign-on**: launcher at `tools.calleva.org` (the
    webmaster delegates that subdomain with one NS record); apps at
    `<app>.tools.calleva.org`, each in its own Firebase project with automatic
    Google sign-in; SAML sign-in for outside tools where plans allow (Fleetio
    first).

### Platform connections

12. **FareHarbor** (River School, Events, Haunted Forest): webhooks per
    dashboard for live changes, a one-time export for history, and the API as a
    nightly check. Bookings carry the activity date. *Needs:* API and webhook
    documentation, a sample webhook message, the export's column headers, and
    which dashboard feeds which line.
13. **Shopify** (River Store): built; needs the app credentials.
14. **HubSpot** (Education Programs, CHAPs group bookings): one pipeline per line.
15. **Digests and alerts**: email and Slack.
16. **Targets**: goals to compare against.

## Open items for Calleva

- Assign the remaining Campminder session groups and Square locations (Settings).
- Check program families against the real program list (Settings).
- Add Haunted Forest's 2027 end date when known (Settings → Seasons).
- Add admins to Firestore `config/access` (until then everyone is an admin).
- Item 3: add a School column to the Campminder report (and the history tabs).
- Item 12: FareHarbor documentation and samples (see above).

## Notes

- **Retail date bases:** Shopify and Square are paid at purchase, so booked,
  paid and service dates are all the sale date. Refunds count on the day issued.
- **Shopify limits:** full order history needs `read_all_orders` approval
  (otherwise 60 days).
- **Campminder seasons:** older seasons were calendar years, so a report's season
  is the one most of its sessions start in, and history tabs are named by year.
- **Long comparisons:** when a date range overlaps its comparison period, the
  overlapping days count in both.
