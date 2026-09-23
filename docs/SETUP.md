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
4. **Project settings → Your apps → Web app (`</>`)**. Register it (no need to
   set up Hosting in the wizard). Copy the config values into
   `apps/web/.env.production` using `apps/web/.env.example` as the template.

## 2. Run the setup script

From a machine with the [gcloud CLI](https://cloud.google.com/sdk/docs/install)
(or Google Cloud Shell, which has everything installed):

```bash
gcloud auth login
cp infra/config.example.sh infra/config.sh   # fill in PROJECT_ID etc.
bash infra/setup.sh
```

This enables APIs, creates the BigQuery datasets, least-privilege service
accounts, Secret Manager entries, and a random pseudonymization key.

## 3. Access list

Firebase console → Firestore → create collection `config`, document `access`:

| field | type | value |
|---|---|---|
| `admins` | array | your email |
| `allowedEmails` | array | leave empty to allow everyone in the domain, or list the ~10 people |

## 4. Dataform

BigQuery console → **Dataform** → Create repository (`dashboard`, region
`us-east1`) → connect it to this GitHub repo, subdirectory `dataform/`.
Then create a **workflow configuration** that runs all actions every 15 minutes.
Re-run `bash infra/setup.sh` afterwards so the Dataform service agent gets its
BigQuery permissions. Set `defaultProject` in `dataform/workflow_settings.yaml`.

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
