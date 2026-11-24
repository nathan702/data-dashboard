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
 FareHarbor          API + webhooks ───────▶└──────────┬──────────────────┘
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
  `business_line_assignments`, `fct_revenue_pace` (revenue by program date
  and booking date, for targets).
- **Report builder data sets** (enrollments, campers by season, campers by
  program family, revenue, store sales) are computed at query time from the
  marts, so they need no extra tables. The Targets data set is pivoted by the
  API from the targets (Firestore) and their progress.
- **Firestore**: sync state and cursors, `config/access`, `config/seasons`, `config/targets`,
  `config/programFamilies`, `config/schools`, saved `reports`, per-person tab order, and the
  geocode cache (`campminder_geocodes`, not readable from the app).
- **Deploys**: every push to the branch deploys automatically; a self-check
  compares the API's numbers with plain table totals (revenue, store sales,
  drill-down filters, Campminder enrollments, every starter report) and fails
  the deploy if they disagree.

## Built so far

- **Foundation**: Google sign-in, business-line tabs (customizable per person),
  Settings, Data status, automatic deploys with self-check.
- **FareHarbor** (live; River School, Events, Haunted Forest): bookings since
  2019, revenue by business line, guests, season to date vs last season,
  night by night, ticket types, when tickets are bought.
- **HubSpot** (live; Education Programs, CHAPs group bookings): deals,
  pipelines, programs and line items.
- **Square** and **Shopify** (live):
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
- **Settings tabs**: one tab per platform's assignments, Seasons, Targets,
  Program families, Schools.
- **Targets**: goals per business line, season and measure on Settings →
  Targets; a Season targets card on each line's page and a Targets table on
  the Overview with where each line is now, where it should be by now at last
  season's pace, and ahead / on track / behind; a Targets data set in the
  report builder.
- **Returning families** (Camp): last season's camp-location families and
  whether they've signed up again, against last season at the same point,
  on the Camp page, in the report builder and in the digests.
- **Revenue per camper** (Campminder lines): net tuition per camper and per
  camper-week, and extras per camper, on the Tuition card against last season
  at the same point; per-camper measures in the report builder.

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
5. **Campminder financials** ✅ The `Financial` tab of the daily sheet
   (current season; past seasons later) is imported without names, card
   details or descriptions, payments split across what they paid for.
   Campminder revenue is on the Overview and business-line pages (service,
   booked and paid dates); a Campminder financials report data set (charges,
   discounts and credits, net tuition, payments, refunds, balances owed,
   households owing); a tuition and balances card on the Camp, CHAPs and
   School Year pages. Camp extras ✅ (Summer Camp line items chosen on
   Settings: Lunch, Gear Bag, Backpack…; Miscellaneous is its own assignable
   entry, out of Camp): a Camp page card with items vs last season at the same point, lunches by week
   × session group, and summer-long items by the camper's first session; line
   item fields and Items sold in the report builder.
6. **Family and sibling reporting** ✅ Siblings = two or more enrolled campers
   from one household (scrambled ID) in a season and business line. Camp
   pages: Families, Families with siblings and Sibling weeks together tiles,
   and a Campers in family breakdown and filter. Reports: Campers in family on
   the camper data sets, and a Families data set (campers per family, weeks
   together, compared with last season, came back).
7. **Registration open dates** ✅ Camp registration opens in waves (returning
   VA families, returning MD families, new families), set per season on
   Settings → Seasons, with each camp session group's state. A family is
   returning when a camper was at a camp location last season. The Camp page's
   "Sign-ups since registration opened" chart lines seasons up by days since
   each family's wave opened (all waves or one; enrollments or campers).
### Next (in order)

8. **Targets** ✅ Goals per business line, season and measure
   (net revenue; campers and enrollments; FareHarbor guests; HubSpot
   participants) on Settings → Targets. "Now" counts the season's programs
   as soon as they're booked; "expected by now" is the target times the share
   of last season's total in by the same point (same date last year; same
   weekday for Events and Haunted Forest; Camp by days since registration
   opened). Within ±5% is on track. Settings, the line-page card, the Overview
   table, the Targets report data set and a deploy self-check.
9. **Shopify** (River Store) ✅ connected (Dev Dashboard app, client
   credentials). Full order history needs Shopify's `read_all_orders`
   approval; without it, 60 days.
10. **HubSpot** ✅ (Education Programs, CHAPs group bookings): deals and pipelines
    every 15 minutes, revenue by pipeline → business line, open pipeline,
    won-by-month and programs on each line's page. Upgraded to a HubSpot
    **service key** (HubSpot stopped new legacy private apps on Oct 26, 2026
    and retires them by September 2027) and the date-versioned `2026-09` APIs
    (supported until about March 2028). No CLI-built app is needed: the
    dashboard only reads, with no webhooks. Connected with a service key.
11. **Digests and alerts** ✅ (Slack). Each person chooses their own on
    🔔 Notifications: Slack direct message and/or email, a daily digest
    (weekdays or every day) and/or a weekly one on Mondays, at an hour they
    pick (6–10am Eastern), for the lines they pick (default: their tabs); and
    alerts (a target turns behind and recovers; a big day above their own %
    threshold; admins: a platform stops syncing, unassigned revenue). Totals
    only. A Cloud Run job `dashboard-digest` runs hourly with the API's own
    code; alert states in Firestore so each fires once; each person's choices
    with their tab order in `users/{sign-in email}` (staff sign-in addresses,
    agreed). Built: the page, the hourly job, Slack DMs through a Calleva Slack
    app (`infra/slack-app-manifest.yaml`; token in secret `slack-bot-token`).
    Email is on hold: `no-reply@calleva.org` is an alternate sending address
    on a personal account today, so sending through it would put every
    message in that person's Sent folder and tie it to their account. Resume
    once there's a dedicated `no-reply@` Workspace account (then OAuth for
    that one account, `gmail.send` only), or send through a personal account
    knowingly. The email box on My notifications stays greyed out until then.

### Then

13. **Decision-making features**, in this order:
    1. **Returning families not yet re-enrolled** ✅ A family is returning
       for season S when a camper was enrolled at a camp location (Settings →
       Seasons → Camp registration) in S − 1; re-enrolled when any of its
       campers (a new sibling too) is enrolled in Camp in S. Families only
       waitlisted or applied, and those who signed up then cancelled, are
       their own statuses; families whose campers are all too old now have
       aged out (oldest age on Settings → Seasons, else the oldest age 1% of
       last season's campers were) and are left out of the percentages.
       "Same point last year" is the same number of days since each family's
       wave opened (else the same date a year earlier). Camp page card (tiles,
       share re-enrolled by days since opening, segments with click-to-filter),
       a Returning families report data set and starter report, a digest line
       while registration is under way, and a deploy self-check. Counts and
       scrambled IDs only: staff pull the families themselves from Campminder.
    2. **Revenue per camper** ✅ Every Financial charge and discount is
       given to a camper: a line under a camper is theirs; one under a parent
       is split across the household's campers enrolled in its session (no
       session: in its business line) in proportion to their charges. A
       session's lines count per camper only when the camper is enrolled in
       that session (cancelled sessions' charges, and lines with no camper,
       are shown as "not counted per camper"). Extras are kept apart. The
       Tuition card (Camp, CHAPs, School Year) shows net tuition per camper,
       per camper-week (weekly sessions) and extras per camper against last
       season at the same point, with the page's filters; Campers by season in
       the report builder has Net tuition, Net tuition per camper and Extras
       per camper (each camper once however a report splits them), plus a
       starter report; a deploy self-check adds them back up to net tuition.
    3. **Forecasts** for every line, from the Targets pace logic.
    4. **Where new families come from.** *Ask:* does Campminder have a "how
       did you hear about us" question that could be added to the report?
    5. **Capacity and waitlists.** *Needs:* session capacity from Campminder
       (a session report tab) or entered on Settings.
    6. **Campers per age group per week (staffing)**, with a projection to
       season end (postponed). *Needs from Calleva:* age groups and staff ratios.
14. **Test and live separation**: a second website (`…-test`) in the same Google
   Cloud project, reading the same raw data into its own tables; changes deploy
   to test first and are promoted to live.
15. **Merged customer database + email sync** (Emma today; the tool may change):
    read-only, rebuilt from the source systems, in BigQuery in its own
    access-restricted dataset. Matching: email, then phone, then standardized
    address + last name (apartment numbers must match); people and households as
    separate layers; "always/never merge" rules only if needed; preview matches
    before turning it on. The email tool holds subscription status and the sync
    never re-adds unsubscribes. Lookups ~1–2 s, audience searches ~1–5 s.
16. **Intranet with single sign-on**: launcher at `tools.calleva.org` (the
    webmaster delegates that subdomain with one NS record); apps at
    `<app>.tools.calleva.org`, each in its own Firebase project with automatic
    Google sign-in; SAML sign-in for outside tools where plans allow (Fleetio
    first).

### Running costs

17. **Lower the fixed Google Cloud bill** (about $20 in October 2026, nearly
    all from schedules, not use): rebuild the tables only when a sync wrote new
    data instead of every 15 minutes (expected 70–90% less on BigQuery and
    Cloud Run), then read only new raw rows if data grows a lot. Safety nets
    to set in the console: a $40/month budget alert, and a 1 TiB "Query usage
    per day" BigQuery quota.

### Last

18. **FareHarbor sell-through** (moved here; not worth it now). FareHarbor
    capacity is set on *resources* (Trail, Town…), not time slots: a Combo
    uses one Trail and one Town, so tickets share buckets, and slot capacity
    is mostly 0. Needs each resource's capacity and which tickets use which
    resources (from FareHarbor's API if it exposes resources, else Settings),
    then sell-through per resource by night and time slot.
19. **Camp page speed** (moved here): keep one API server always running so
    pages don't wait for one to start (about $5–10 a month; would be offset
    by item 17). Waiting on approval.

## Open items for Calleva

- Assign the remaining Campminder session groups and Square locations (Settings).
- Check program families against the real program list (Settings).
- Add Haunted Forest's 2027 end date when known (Settings → Seasons).
- Add 2027 registration opening dates (Settings → Seasons) so Camp targets
  line up by days since registration opened; until then they use the same
  date last year.
- Enter targets (Settings → Targets).
- Add admins to Firestore `config/access` (until then everyone is an admin).
- Item 3: add a School column to the Campminder report (and the history tabs).

## Notes

- **Retail date bases:** Shopify and Square are paid at purchase, so booked,
  paid and service dates are all the sale date. Refunds count on the day issued.
- **Shopify limits:** full order history needs `read_all_orders` approval
  (otherwise 60 days).
- **Campminder seasons:** older seasons were calendar years, so a report's season
  is the one most of its sessions start in, and history tabs are named by year.
- **Long comparisons:** when a date range overlaps its comparison period, the
  overlapping days count in both.
