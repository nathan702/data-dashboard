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
| `admins` | array | your email |
| `allowedEmails` | array | leave empty to allow everyone in the domain, or list the ~10 people |

## 4. SQL transforms

Nothing to do. The SQL models in `dataform/` run as a Cloud Run job
(`dashboard-transform`) every 15 minutes, created by the deploy script. No
Dataform repository or GitHub connection is needed. (If one was created in the
BigQuery → Dataform page, it's unused and can be deleted.) Run history is in
Cloud Run → Jobs → dashboard-transform.

## 5. Deploy

```bash
bash infra/deploy.sh
```

The app is then at `https://<project-id>.web.app`.

## Source credentials (added phase by phase)

Each is stored with:
`echo -n "VALUE" | gcloud secrets versions add SECRET_NAME --data-file=-`

| Phase | Secret | Where to get it |
|---|---|---|
| 2 | `shopify-admin-token`, `shopify-webhook-secret` | Shopify admin → Settings → Apps → Develop apps → Create app (read-only scopes listed in the Phase 2 notes) |
| 2 | `square-access-token`, `square-webhook-signature-key` | developer.squareup.com → your app → Production credentials / Webhooks |
| 3 | `hubspot-private-app-token`, `hubspot-client-secret` | HubSpot → Settings → Integrations → Private apps |
| 4 | — | Campminder automation gets write access to the ingest bucket |
| 5 | — | Gmail API access to the FareHarbor notifications mailbox |
