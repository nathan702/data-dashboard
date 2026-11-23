# Setup

Everything here is one-time. It takes about 30 minutes.

## 1. Create the Firebase / Google Cloud project

1. Go to <https://console.firebase.google.com> → **Add project**. Name it e.g.
   `calleva-dashboard`. Google Analytics is not needed.
2. **Upgrade to the Blaze plan** (bottom-left gear → Usage and billing). Required
   for Cloud Run and Scheduler; the free tiers still apply. Set a budget alert:
   Google Cloud console → Billing → Budgets & alerts → $50/month.
3. **Authentication** → Get started → **Google** provider → Enable.
   Under Settings → Authorized domains, the `web.app` domain is already listed.
4. ~~Register a web app~~ Done: the web config for `calleva-dashboard` is in
   `apps/web/.env.production`. (If the project is ever recreated: Project
   settings → Your apps → `</>` → copy the `firebaseConfig` values into that file.)

## 2. Run the setup script

The easiest place to run this is **Google Cloud Shell**, which has every tool
installed: open <https://console.cloud.google.com/?project=calleva-dashboard>
and click the **>_** (Activate Cloud Shell) icon at the top right. Then:

```bash
git clone https://github.com/nathan702/data-dashboard.git
cd data-dashboard
git checkout claude/ecstatic-maxwell-hh3yl3
bash infra/setup.sh
```

Project settings (project ID, region, domain) are in `infra/config.sh`.

This enables APIs, creates the BigQuery datasets, least-privilege service
accounts, Secret Manager entries, and a random pseudonymization key.

## 3. Access list

Firebase console → Firestore → create collection `config`, document `access`:

| field | type | value |
|---|---|---|
| `admins` | array | your email, plus anyone else who should change Settings and see the Advanced menu |
| `allowedEmails` | array | leave empty to allow everyone in the domain, or list the ~10 people |

Until `admins` has at least one email, everyone who can sign in is treated as
an admin (the Settings page shows a reminder).

## 4. SQL transforms

Nothing to do. The SQL models in `dataform/` run as a Cloud Run job
(`dashboard-transform`) every 15 minutes, created by the deploy script. No
Dataform repository or GitHub connection is needed. (If one was created in the
BigQuery → Dataform page, it's unused and can be deleted.) Run history is in
Cloud Run → Jobs → dashboard-transform.

## 5. Deploy

**Automatic, after review:** only `main` deploys. Every change is made on a
separate branch and opened as a pull request with a summary of what it
changes; the checks (typecheck, tests, build, Dataform compile) run on the
pull request. Merging it into `main` deploys it through GitHub Actions
(`.github/workflows/ci.yml`), and the live self-check runs after each deploy.
Progress and history: GitHub → the repository → **Actions** tab; every change
and its description: **Pull requests → Closed**.

**Undoing a change:** open the merged pull request on GitHub and click
**Revert**. That opens a new pull request that reverses it; merge it to deploy.
For an emergency, roll back instantly in the Firebase console (**Hosting →
Release history → Roll back**) and in Cloud Run (`dashboard-api` →
**Revisions → Manage traffic**), then revert the pull request so the next
deploy doesn't bring the change back. GitHub signs
in to Google Cloud as `dashboard-deployer` through workload identity
federation (no stored keys); `infra/setup.sh` sets this up.

**By hand** (e.g. the very first deploy, or if Actions is unavailable):

```bash
bash infra/deploy.sh
```

The app is at `https://calleva-dashboard.web.app`.

## Seasons

Each business line's seasons are set on **Advanced → Settings → Seasons**:
calendar year, Campminder's season (Labor Day starts the next one), or a
last day set for each year (Haunted Forest: the last night of the run).
Numbers are grouped by program or activity date. Campminder's own seasons
(pace charts, "same point last season") follow Labor Day unless a year is
listed there with a different first day. Stored in Firestore at
`config/seasons`.

## Targets

Goals are set on **Advanced → Settings → Targets** (admins), one season at a
time: per business line, net revenue and whatever its platforms count
(campers and enrollments, FareHarbor guests, HubSpot participants). Empty
boxes mean no target. Each line's page then shows a **Season targets** card:

- **Now**: the season's programs (by program date, the line's season rule)
  counted as soon as they're booked; stores count sales to date. Campers and
  enrollments count by sign-up date, guests by booking date, participants by
  deal close date.
- **Expected by now**: the target times the share of last season's final
  total it had by the same point. The same point is the same date last year,
  the same weekday for Events and Haunted Forest, and for Camp the same
  number of days since registration opened (needs both seasons' opening
  dates on Settings → Seasons; otherwise the same date).
- **Status**: within ±5% of expected is on track; above is ahead, below is
  behind. A finished season shows reached or missed.

The **Overview** lists every line's targets in one table, and **Reports →
Targets** is a report builder data set (target, now, expected by now, % of
target, % of expected by season, line, measure and status).

The card opens on the season under way; once last season had everything in
by this point (Camp in the fall), it moves on to next season's targets if
they're set. Stored in Firestore at `config/targets`. Revenue comes from
`marts.fct_revenue_pace` (revenue by program date and booking date), which
the deploy self-check compares with the service-date revenue totals.

## Returning families (Camp)

The Camp page's **Returning families** card follows last season's families
into this one: households with a camper enrolled at a camp location (the
session groups marked Virginia or Maryland on **Advanced → Settings → Seasons
→ Camp registration**) last season, and whether they've signed up for Camp
again.

- **Re-enrolled**: any of the household's campers is enrolled in Camp this
  season (a new sibling counts). **Waitlisted or applied** and **Signed up,
  then cancelled** are their own statuses; **Not yet** is everyone else.
- **Aged out**: every camper the family had last season is now older than
  the **Oldest camper age** (June 1) on Settings → Seasons → Camp
  registration. Blank means automatic: the oldest age at least 1% of last
  season's campers were. Aged-out families aren't in the percentages.
- **Same point last year**: last season's families re-enrolled by the same
  number of days since their wave opened (both seasons' opening dates
  needed), else by the same date a year earlier.
- The card opens on the season whose registration is next or under way
  (after Labor Day, next summer's) and has its own season, wave and
  segment filters; the page's filters don't apply to it.

**Reports → Returning families** has the same rows (one per household and
season) with status, wave, last season's location, summers at camp, campers
and weeks last season, weeks after opening, state, ZIP and the scrambled
household ID. Digests show a Camp line ("returning families: 412 of 980
re-enrolled, last year 38% at this point") from the day the season's first
wave opens until its summer ends. Nothing new is stored: everything is worked
out from the enrollments table when it's viewed, and names are never shown,
so the families themselves come from Campminder.

## Notifications (digests and alerts)

Each person chooses their own on **🔔 Notifications** (next to their email
at the top): where to send (a Slack direct message; email comes next), a
daily digest (weekdays or every day) and/or a weekly one on Mondays, the hour
(6–10am Eastern), which business lines (default: their tabs), and alerts:

- a target falls behind pace, and when it recovers;
- a big day: yesterday's bookings this far above or below the same day last
  year (each person sets the %; days under $500 last year are skipped);
- admins only: a platform stops syncing, and revenue arrives that isn't
  assigned to a business line.

Digests show what was booked (net) per line against the same day last year
(same weekdays for Events and Haunted Forest), the targets of seasons under
way, Camp and School Year sign-ups, and whether data is up to date. Totals
only. **Send me a test** sends yesterday's digest straight away.

A Cloud Run job, `dashboard-digest`, runs at :05 past every hour (Cloud
Scheduler). It runs the API's own code under the API's account, so its
numbers match the dashboard. What alerts last saw is kept in Firestore
(`notifications/state`) so each fires once per change; each person's choices
are kept with their tab order in `users/{sign-in email}`. The deploy
self-check builds both digests (without sending) on every deploy.

### Slack app (once)

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** →
   choose the Calleva workspace → paste `infra/slack-app-manifest.yaml` →
   **Create**. (Needs a Slack admin, or a member allowed to install apps.)
2. **Install to Workspace** → **Allow**.
3. **OAuth & Permissions** → copy the **Bot User OAuth Token** (`xoxb-…`) and
   store it (the command waits for it; nothing is shown):

   ```bash
   read -rs V && printf '%s' "$V" | gcloud secrets create slack-bot-token --project=calleva-dashboard --replication-policy=automatic --data-file=- && unset V
   ```
4. Let the API's account read that one secret:

   ```bash
   gcloud secrets add-iam-policy-binding slack-bot-token --project=calleva-dashboard --member=serviceAccount:dashboard-api@calleva-dashboard.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
   ```

Within 5 minutes My notifications stops saying Slack isn't set up. People
are found in Slack by their sign-in email, so their Slack account must use
the same address. To replace the token later, use `gcloud secrets versions
add slack-bot-token` the same way.

## Reports

The **Reports** tab is a report builder: pick a data set (enrollments,
campers by season, campers by program family, revenue, store sales), up to
two fields down the side and one across the top, a measure, filters, and a
table, bar, line or heat-map view. Anyone can save reports, privately or
shared; owners (and admins) can change or delete them. Five starter reports
are built in and can be copied. Only vetted fields and measures exist (in
`packages/shared/src/reports.ts`, SQL in `services/api/src/warehouse/reportSql.ts`),
so reports can't reach anything else. Saved reports live in Firestore
(`reports`); program families and schools (Settings) in
`config/programFamilies` and `config/schools` (schools added by hand, and
each spelling an admin has settled).

## Connecting sources

Credentials are stored in Secret Manager and read by the connectors on every
run, so **adding them needs no redeploy**: the next scheduled sync (every 15
minutes) picks them up. Until then a source shows "Not connected" on the
Status page.

To store a value, run this in Cloud Shell, paste the value, press **Enter**,
then **Ctrl+D**. (Pasting this way keeps it out of your shell history.)

```bash
gcloud secrets versions add SECRET_NAME --data-file=-
```

### Shopify

1. Shopify admin → **Settings → Apps → Develop apps → Build apps in Dev Dashboard**.
2. **Create app** → *Start from Dev Dashboard* → name it `Business dashboard` → **Create**.
3. **Versions** tab → create a version:
   - **App URL:** `https://calleva-dashboard.web.app`
   - **Webhooks API version:** `2026-07`
   - **Access scopes:** `read_orders`, `read_all_orders`, `read_products`, `read_inventory`, `read_locations`
   - **Release** the version.
4. App **Home** → **Install app** → choose your store → **Install**.
5. App **Settings** → copy the **Client ID** and **Client secret**.
6. Store three secrets:
   - `shopify-shop` — your store's `.myshopify.com` address (e.g. `calleva.myshopify.com`,
     shown in Shopify admin → Settings → Domains)
   - `shopify-client-id`
   - `shopify-client-secret`

Shopify only lets apps read the **last 60 days** of orders unless it approves
`read_all_orders`. If the dashboard's Shopify history stops at 60 days, that
approval is what's missing.

Real-time order updates (webhooks) are registered automatically on the first sync.

### Square

1. Go to <https://developer.squareup.com/apps> and sign in with the Square account.
2. **Create an application**, named `Business dashboard`.
3. Open it → **Credentials** → switch the toggle to **Production** → **Production Access token** → **Show** → copy it.
4. Store it as the `square-access-token` secret.

The webhook subscription and its signing key are created automatically on the
first sync. The token doesn't expire; if it's ever replaced in the Developer
Console, store the new one the same way.

### Campminder

The existing report automation overwrites a Google Sheet once a day. The
dashboard reads its `Sheet1` tab (one row per camper) every hour at :05 and
skips it when nothing changed.

1. Open the sheet → **Share** → add
   `dashboard-connectors@calleva-dashboard.iam.gserviceaccount.com` as **Viewer**
   (untick "Notify people").
2. The sheet id lives in `infra/config.sh` (`CAMPMINDER_SHEET_ID`). If the
   automation ever writes to a different sheet, change it there and push.
3. On the **Settings** page, choose a business line for each session group
   (weekly groups default to Camp).

What's stored: for each camper-session, only the season, session, program,
status, dates, gender, age on June 1, grades, school, parents' occupation
categories, years at camp, home state, home ZIP and the home's map coordinates. People are keyed by a one-way hash of
their Campminder id. Names, birth dates, street addresses, parents and
medical details are never written to the warehouse.

**Home locations (family map).** Leadership chose exact locations for the
map. Each family's address is sent once to the free US Census Bureau
geocoder, which returns coordinates. The street address itself isn't kept:
results are cached in Firestore (`campminder_geocodes`, not readable from
the app) under a keyed hash of the address, and only the coordinates reach
BigQuery. The coordinates still pinpoint a home, so treat the map as
sensitive. Addresses the geocoder can't match are counted as "not on the map".

**Seasons.** The season is taken from the latest session start in the report,
so when the automation switches to 2027 the new rows are saved as 2027 and
2026 stays as it was last seen. To force a season (for example, if an early
2027 report still lists 2026 sessions), store it as the `campminder-season`
secret and delete that secret's versions once it isn't needed.

**Past seasons.** Put each season's report (same per-camper layout as
`Sheet1`) in its own tab of a separate sheet, named by its year (`2022`,
`2023`, …), share it the same way, and set `CAMPMINDER_HISTORY_SHEET_ID` in
`infra/config.sh`. Each tab is imported as that season on the next hourly
sync, and again only when it changes. A tab whose sessions belong to a
different year is refused. Tabs for the daily sheet's season or later are
ignored, and deleting a tab or the whole sheet keeps what was imported.

**Financials.** A tab named `Financial` in the same sheet (Campminder's
transaction report: one row per charge, credit, payment, refund or transfer)
is imported on the same hourly sync into `raw_campminder.transactions`, and
again only when it changes. Kept: transaction id, season, type, financial
category, dates (post, effective, reversal, service), quantity and amounts,
payment method, session, session group and program, and the person and
household ids as the same keyed hashes as enrollments, and on charges and
credits only, the Description, which there is the line item's name ("Farm
Week 3", "Week 3 Lunch", "Gear Bag"). Never stored: names, household names,
card details, check and deposit numbers, and payment and refund
descriptions. A different tab name can be set with
`CAMPMINDER_FINANCIAL_TAB`; a sheet without the tab is skipped. A payment
the report splits across what it paid for (camp and CHAPs) is several rows
with the same transaction id; each is kept as its own line.

**Camp extras.** Only the Summer Camp financial category counts. Settings →
Seasons → Camp extras lists every Summer Camp line item (weeks dropped, so
every "Week 3 Lunch" is Lunch) to tick the ones that are extras rather than
tuition; until some are ticked, lunches, gear bags, backpacks and
cancellation fees are. A lunch belongs to the session on its own line; an
item with no session (Gear Bag, Fuel Charge) goes with the camper's first
enrolled session that season, and so does its business line. The Camp
page's Camp extras card shows each item against last season at the same
point, lunches by week and session group, and summer-long items by first
session; the Campminder financials report data set has Line item, Line item
(weeks combined), Line item week, Session group (extras) and Items sold.

**Miscellaneous.** Lines in the Miscellaneous financial category never count
toward a session's business line: they are their own "Financial category:
Miscellaneous" entry on Settings → Campminder, unassigned until a business
line is chosen for them.

**Past seasons' financials.** In the same history sheet as the past camper
reports, add a tab per season named `Financial 2022`, `Financial 2023`, … with
that season's Campminder Financial report (same columns as the daily
`Financial` tab; a title line above the headers is fine). Each tab is imported
as its season on the next hourly sync, and again only when it changes; rows
for other seasons in a tab are left out. A tab with none of its own season's
rows is refused. A season with a history tab belongs to it: the daily
`Financial` tab leaves that season alone even if it lists a few of its rows.
Tabs for the daily sheet's season or later are ignored.

Amounts keep Campminder's signs (charges and refunds positive, credits and
payments negative), so a household's balance is the sum of its lines and a
reversal, its own line with the opposite sign, nets out. Each line's business
line is its session group's; else its financial category's (Summer Camp and
LIT → Camp, CHAPS → CHAPs, Extracurricular → School Year Programs, River
School → River School, changeable on **Settings → Campminder**); else
(Miscellaneous, System, unsplit payments, refunds) the household's main line
that season, the one with its largest charges. Revenue counts charges less
discounts by service start date (or post date for "booked"), payments by post
date for "collected", and refunds on their post date; transfers between
accounts or seasons aren't revenue.

**Parent occupations.** The report's `F1P1 Occupation`, `F1P2 Occupation`,
`F2P1 Occupation` and `F2P2 Occupation` columns (up to two parents in each of
two households) are read on import and sorted into a category: Legal,
Medicine and health, Education, Government and military, Finance,
Technology, Business and management, Nonprofit, Science and research, Arts
and media, Real estate and construction, Trades, Homemaker, Retired or Other
(`packages/shared/src/occupations.ts`, by keywords such as "attorney" →
Legal). Only the categories are stored, never what was typed; blank and
"N/A" answers, emails and phone numbers count as not answered. Reports have a
**Parent occupation** field and the Camp pages a Parent occupation breakdown
and filter; a family with parents in two fields counts under each.

**Schools.** Add the camper's school to the Campminder report the automation
runs (and to the past-season tabs, if they can be re-exported). Any column
named `School`, `School Name`, `Current School`, `Child School` or `Camper
School` is picked up on the next hourly sync; no change here is needed.
Answers that aren't a school (an email address, a username, phone number,
street address, weight, height, age, grade, or a long answer to another
question) are dropped before anything is stored.

Each spelling is then matched to an actual school: the official directory
(`services/api/data/official-schools.json`, from the U.S. Department of
Education) or a school added on **Settings → Schools**. The
matcher (`packages/shared/src/schoolMatch.ts`) allows for typos, sound-alike
spellings, missing or extra words, abbreviations and initials; it matches
automatically when it's at least 90% sure and otherwise puts the spelling in
the review list, grouped with its look-alikes. On **Settings → Schools**,
admins accept a suggestion, choose another school, add a school that isn't in
the directory (preschools, schools abroad), or mark an answer **not a
school**. Answers marked not a school are left out of every import from the
next sync on, and the hourly sync removes them from older stored rows once a
day (rows from the current day can't be changed until BigQuery settles them).
Reports get *School*, *School as entered*, *School type*, *School state* and
*School county*; the Camp pages can break down and filter by school.

**Official school list.** `services/api/data/official-schools.json` holds every
open public and private school in DC, Maryland and Virginia (about 5,600),
with type, state, county and city, built by
`python3 scripts/fetch_official_schools.py` from the Department of
Education's public data (public schools: Common Core of Data via
educationdata.urban.org; private schools: the Private School Universe
Survey on nces.ed.gov, combined across survey years since 2013–14 because
each year's public file only has the schools that answered). Re-run it about
once a year, when new data is out, and open a pull request with the result.
Private schools appear once however many campuses they have, and a charter
with up to three campuses ("Mundo Verde Bilingual PCS") is one school. Schools
in the counties families mostly come from are marked "nearby", which the
matcher prefers when two schools share a name; the list is in the script.

**Safety.** If a report arrives with fewer than half the camper-sessions
already stored for its season, it's treated as a half-written sheet: nothing
is changed and the sync shows as failed until a complete report arrives.

### FareHarbor

The dashboard uses FareHarbor's **Public API** (at `api.fareharbor.com/v1`). Each FareHarbor company (River
School, Events, Haunted Forest) has its own key, made in that company's
dashboard:

1. FareHarbor dashboard for the company → **Settings → Users & Permissions** →
   open the user who will own the key (they need permission to **view amounts**,
   or prices come through blank) → **API Keys → Public API → Add API key**.
   Name it `Business dashboard`. Copy the **Client ID** and **Client Secret**
   (the secret is shown only once; **Rotate** makes a new one).
2. Note the company's **shortname**: the part after `fareharbor.com/` in the
   dashboard's address (e.g. `fareharbor.com/riverschool/dashboard` → `riverschool`).
3. Store the keys in Cloud Shell, replacing `SHORTNAME` (paste each value, Enter, Ctrl+D):

   ```bash
   gcloud secrets create fareharbor-SHORTNAME-client-id --replication-policy=automatic
   gcloud secrets versions add fareharbor-SHORTNAME-client-id --data-file=-
   gcloud secrets create fareharbor-SHORTNAME-client-secret --replication-policy=automatic
   gcloud secrets versions add fareharbor-SHORTNAME-client-secret --data-file=-
   ```
4. List the companies to read, comma-separated, in the `fareharbor-companies`
   secret (e.g. `riverschool,calleva-events,hauntedforest`). Add a company here
   only once its keys are stored: until every listed company has keys, FareHarbor
   shows as "Not connected".

The hourly sync (at :35) then reads every booking since 2019, 100 at a time,
and afterwards only new bookings. Bookings with recent or upcoming activity
are re-read every 6 hours (cancellations, refunds) and all bookings weekly.

**Settings → Business lines → FareHarbor**: check each company is assigned to
the right business line (shortnames containing "haunt", "river" or "event" are
assigned automatically).

What's stored: for each booking, its company, item, activity date and time,
status, number of guests and customer types ("2 Adult, 1 Child"), totals,
refunds and amount paid; and each time slot's capacity. **Never** the
customer's name, email or phone, custom field answers, voucher numbers or tags.

FareHarbor's Public API gives booking totals, not individual payments, so
"collected" revenue for FareHarbor is what's been paid, dated the day the
booking was made.

**Webhooks (optional, for changes within the hour).** Generate a random key
and store it:

```bash
gcloud secrets create fareharbor-webhook-key --replication-policy=automatic
openssl rand -hex 24 | tr -d '\n' | gcloud secrets versions add fareharbor-webhook-key --data-file=-
gcloud secrets versions access latest --secret=fareharbor-webhook-key; echo
```

Then ask FareHarbor to send **booking webhooks** for each company to:

```
https://dashboard-connectors-webhooks-PROJECT_NUMBER.us-east1.run.app/webhooks/fareharbor?key=THE_KEY
```

(`PROJECT_NUMBER` is on the Cloud console home page; the region is the one in
`infra/config.sh`.) Each webhook is checked against the key, and the booking
is then re-read from the API, so a forged one can't change any numbers.

### HubSpot

The dashboard reads HubSpot **deals** (and the deal pipelines) with a
**service key**, through HubSpot's date-versioned APIs (`2026-09`, supported
until about March 2028; set `HUBSPOT_API_VERSION` to move on). It never reads
contacts, companies, emails or notes. (HubSpot stopped new legacy private apps
on October 26, 2026 and retires existing ones by September 2027. A
`hubspot-private-app-token` secret is still used if there's no service key.)

1. HubSpot → **Development** → left menu **Keys → Service keys** → **Create
   service key** (needs a Super Admin or the Developer tools permission).
   Name it `Business dashboard`.
2. **Add new scope** → tick only `crm.objects.deals.read`,
   `crm.schemas.deals.read` and `crm.objects.line_items.read` (all read-only)
   → **Update** → **Create**. Then click the key's name → **Show** → **Copy**.
   (Without the line-items scope, everything else still syncs.)
3. Store it (the command waits for the key; paste it and press Enter; nothing
   is shown):

   ```bash
   read -rs V && printf '%s' "$V" | gcloud secrets create hubspot-service-key --project=calleva-dashboard --replication-policy=automatic --data-file=- && unset V
   ```

   To replace it later (e.g. after rotating the key in HubSpot), use
   `gcloud secrets versions add hubspot-service-key` the same way. Each sync
   logs which credential it used (`hubspot credential`). HubSpot can rotate
   the key automatically every 3, 6 or 12 months (key page → **Automatic
   rotation**); store the new one when HubSpot emails about it.
4. The program date is the deal property named in
   `HUBSPOT_SERVICE_DATE_PROPERTY` in `infra/config.sh` (now `start_datetime`).
   Revenue by service date and the programs section use it; a deal without it
   falls back to its close date.
5. **Settings → Business lines → HubSpot pipelines**: choose a business line
   for each pipeline (names containing "CHAP" go to CHAPs, and "education",
   "field trip" or "school" to Education Programs, until set).

The sync runs every 15 minutes: all deals on the first run, then only deals
changed since; deals deleted in HubSpot are removed once a day. Won deals are
revenue on their close date (booked, and collected, since HubSpot doesn't hold
payments) and on the program date (service).

6. **Settings → Seasons → HubSpot properties**: which deal property is
   Participants, Chaperones, Program type, Uses our food and Uses our
   transportation ("Automatic" picks the first property whose label fits).

What's stored: deal id, pipeline, stage, amount, currency, created and close
dates, won/closed, the values of the account's own **date, number, dropdown
and yes/no** properties (fixed choices, e.g. program type), and each deal's
line items (product name, SKU, quantity, price, amount, discount). **Never**
deal names (they often name a school or a person), contacts, companies,
owners, notes or any free-text property.
