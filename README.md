# Business Dashboard

Live dashboards for Campminder, FareHarbor, HubSpot, Shopify and Square in one
place. Google Workspace sign-in; data in BigQuery; runs on Firebase + Cloud Run.

- **Plan & decisions:** [docs/PLAN.md](docs/PLAN.md)
- **One-time setup & deploy:** [docs/SETUP.md](docs/SETUP.md)

## Repository layout

| Path | What |
|---|---|
| `apps/web` | React dashboard (Vite), deployed to Firebase Hosting |
| `services/api` | Dashboard API (Express on Cloud Run): sign-in checks, BigQuery queries, caching |
| `services/connectors` | Source connectors (Cloud Run): scheduled syncs, webhooks, raw writes |
| `packages/shared` | Types, business lines, Eastern-time dates, Campminder seasons, filter validation |
| `dataform` | SQL models: raw → staging → marts (`dim_date`, `fct_revenue_daily`, …) |
| `services/transform` | Cloud Run job that runs the `dataform/` models every 15 minutes |
| `infra` | `setup.sh`, `deploy.sh`, Cloud Build, Firestore rules |

## Local development

Requires Node 22.

```bash
npm install
npm run dev:demo      # API with generated demo data + web app, no sign-in
```

Open <http://localhost:5173>. Demo data is made up and only exists locally.

Checks (same as CI):

```bash
npm run build -w packages/shared
npm run typecheck && npm test && npm run build
```

## Adding a connector

1. Create `services/connectors/src/sources/<source>.ts` exporting a `Connector`
   (`sync()` for polling/backfill, `handleWebhook()` for pushes; verify
   signatures and throw `WebhookAuthError` on failure).
2. Register its factory in `services/connectors/src/sources/index.ts`.
3. Add staging/mart models in `dataform/definitions/` and list the revenue
   model in `dataform/includes/revenue_sources.js`.
4. Add a Cloud Scheduler job calling `POST /run/<source>` on the jobs service.

Personal details must be dropped before `emit()`; use `pickAllowed()` and
`pseudonymize()` from `core/privacy.ts`.
