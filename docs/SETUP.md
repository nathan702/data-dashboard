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

**Automatic:** every push to `main` (or the current development branch) that
passes the checks is deployed by GitHub Actions (`.github/workflows/ci.yml`).
Progress and history: GitHub → the repository → **Actions** tab. GitHub signs
in to Google Cloud as `dashboard-deployer` through workload identity
federation (no stored keys); `infra/setup.sh` sets this up.

**By hand** (e.g. the very first deploy, or if Actions is unavailable):

```bash
bash infra/deploy.sh
```

The app is at `https://calleva-dashboard.web.app`.

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
status, dates, gender, age on June 1, grades, years at camp, home state, home
ZIP and the home's map coordinates. People are keyed by a one-way hash of
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

**Safety.** If a report arrives with fewer than half the camper-sessions
already stored for its season, it's treated as a half-written sheet: nothing
is changed and the sync shows as failed until a complete report arrives.

### HubSpot, FareHarbor

Instructions arrive with their phases.
