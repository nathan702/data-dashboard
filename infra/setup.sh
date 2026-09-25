#!/usr/bin/env bash
# One-time (and safe to re-run) Google Cloud setup for the dashboard.
# Prerequisites: gcloud CLI signed in as a project owner, billing enabled.
#   (settings live in infra/config.sh)
#   bash infra/setup.sh
set -euo pipefail
trap 'echo; echo "ERROR: setup stopped at line $LINENO while running: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")"
source ./config.sh

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  bigquery.googleapis.com firestore.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com \
  identitytoolkit.googleapis.com gmail.googleapis.com storage.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com

echo "==> Firestore (native mode)"
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 \
  || gcloud firestore databases create --location=nam5 --type=firestore-native

echo "==> BigQuery datasets"
for ds in raw_campminder raw_fareharbor raw_hubspot raw_shopify raw_square staging marts ops config dataform_assertions; do
  bq --location="$BQ_LOCATION" show "$PROJECT_ID:$ds" >/dev/null 2>&1 \
    || bq --location="$BQ_LOCATION" mk --dataset "$PROJECT_ID:$ds"
done
bq show "$PROJECT_ID:ops.sync_runs" >/dev/null 2>&1 || bq mk --table \
  --time_partitioning_field started_at --time_partitioning_type DAY \
  "$PROJECT_ID:ops.sync_runs" \
  run_id:STRING,source:STRING,mode:STRING,started_at:TIMESTAMP,finished_at:TIMESTAMP,status:STRING,rows_written:INT64,error:STRING

bq show "$PROJECT_ID:config.business_line_map" >/dev/null 2>&1 || bq mk --table \
  "$PROJECT_ID:config.business_line_map" \
  source:STRING,kind:STRING,assign_key:STRING,business_line:STRING,updated_by:STRING,updated_at:TIMESTAMP >/dev/null

echo "==> Raw tables (created empty so the SQL transforms run before a source is connected)"
# Must match RAW_TABLE_SCHEMA in services/connectors/src/core/bigquery.ts
RAW_TABLES="raw_shopify.orders raw_shopify.products raw_shopify.inventory_levels
  raw_square.locations raw_square.catalog_objects raw_square.orders raw_square.payments raw_square.refunds"
for t in $RAW_TABLES; do
  bq show "$PROJECT_ID:$t" >/dev/null 2>&1 || bq mk --table \
    --time_partitioning_field ingested_at --time_partitioning_type DAY --clustering_fields record_id \
    "$PROJECT_ID:$t" ./raw_table_schema.json >/dev/null
done

echo "==> Secrets (values are added later in the console: Security → Secret Manager → secret → New version)"
for s in pseudonymization-key shopify-shop shopify-client-id shopify-client-secret square-access-token square-webhook-signature-key hubspot-private-app-token hubspot-client-secret; do
  gcloud secrets describe "$s" >/dev/null 2>&1 || gcloud secrets create "$s" --replication-policy=automatic
done
if [ "$(gcloud secrets versions list pseudonymization-key --format='value(name)' | wc -l)" = "0" ]; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add pseudonymization-key --data-file=- >/dev/null
  echo "   generated pseudonymization-key"
fi

echo "==> Service accounts (least privilege)"
make_sa() { gcloud iam service-accounts describe "$1@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$1" --display-name="$2"; }
make_sa dashboard-api "Dashboard API (reads marts)"
make_sa dashboard-connectors "Dashboard connectors (writes raw)"
make_sa dashboard-transform "Dashboard SQL transforms (raw → marts)"
make_sa dashboard-scheduler "Cloud Scheduler invoker"
API_SA="dashboard-api@$PROJECT_ID.iam.gserviceaccount.com"
CONN_SA="dashboard-connectors@$PROJECT_ID.iam.gserviceaccount.com"
XFORM_SA="dashboard-transform@$PROJECT_ID.iam.gserviceaccount.com"
SCHED_SA="dashboard-scheduler@$PROJECT_ID.iam.gserviceaccount.com"

# Dataset-level access via BigQuery's GRANT statement (idempotent). Errors stay visible.
grant_dataset() {
  bq query --quiet --format=none --use_legacy_sql=false --location="$BQ_LOCATION" \
    "GRANT \`$2\` ON SCHEMA \`$PROJECT_ID.$3\` TO \"serviceAccount:$1\""
}
bind() { gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$1" --role="$2" --condition=None >/dev/null; }
# API: run queries, read marts, save Settings-page assignments (config), read sync
# state and keep per-person tab preferences in Firestore, verify sign-ins.
bind "$API_SA" roles/bigquery.jobUser
bind "$API_SA" roles/datastore.user
bind "$API_SA" roles/firebaseauth.viewer
grant_dataset "$API_SA" roles/bigquery.dataViewer marts
grant_dataset "$API_SA" roles/bigquery.dataEditor config
# Connectors: write raw_* and ops, keep sync state, read their secrets.
bind "$CONN_SA" roles/bigquery.jobUser
bind "$CONN_SA" roles/datastore.user
for ds in raw_campminder raw_fareharbor raw_hubspot raw_shopify raw_square ops; do
  grant_dataset "$CONN_SA" roles/bigquery.dataEditor "$ds"
done
bind "$CONN_SA" roles/secretmanager.secretAccessor
# Transforms: read raw_* and ops, rebuild staging/marts and run assertions.
bind "$XFORM_SA" roles/bigquery.jobUser
for ds in raw_campminder raw_fareharbor raw_hubspot raw_shopify raw_square ops config; do
  grant_dataset "$XFORM_SA" roles/bigquery.dataViewer "$ds"
done
for ds in staging marts dataform_assertions; do
  grant_dataset "$XFORM_SA" roles/bigquery.dataEditor "$ds"
done

# Connectors save the Square webhook signing key themselves when they create the subscription.
gcloud secrets add-iam-policy-binding square-webhook-signature-key \
  --member="serviceAccount:$CONN_SA" --role=roles/secretmanager.secretVersionAdder >/dev/null

echo "==> Container registry"
gcloud artifacts repositories describe dashboard --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create dashboard --repository-format=docker --location="$REGION"

echo "==> Automatic deploys from GitHub ($GITHUB_REPO)"
# GitHub signs in with its own short-lived identity token (workload identity
# federation), so no key is ever stored in GitHub. Only this repository's
# deploy branches are trusted, and only to act as the deployer account.
make_sa dashboard-deployer "GitHub Actions deployer"
DEPLOY_SA="dashboard-deployer@$PROJECT_ID.iam.gserviceaccount.com"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
REFS=$(for b in $DEPLOY_BRANCHES; do printf "'refs/heads/%s'," "$b"; done); REFS="[${REFS%,}]"
CONDITION="assertion.repository == '$GITHUB_REPO' && assertion.ref in $REFS"
if gcloud iam workload-identity-pools providers describe github-repo --location=global --workload-identity-pool=github >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc github-repo --location=global --workload-identity-pool=github \
    --attribute-condition="$CONDITION" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc github-repo --location=global --workload-identity-pool=github \
    --display-name="$GITHUB_REPO" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="$CONDITION" >/dev/null
fi
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GITHUB_REPO" >/dev/null
# What the deployer may do: publish Cloud Run services/jobs, schedules and the
# website, and run services as their own accounts. No access to data or secrets.
for role in roles/run.admin roles/cloudscheduler.admin roles/firebasehosting.admin roles/firebaserules.admin \
            roles/firebase.viewer roles/serviceusage.serviceUsageConsumer; do
  bind "$DEPLOY_SA" "$role"
done
gcloud artifacts repositories add-iam-policy-binding dashboard --location="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/artifactregistry.writer >/dev/null
for sa in "$API_SA" "$CONN_SA" "$XFORM_SA" "$SCHED_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$sa" --member="serviceAccount:$DEPLOY_SA" \
    --role=roles/iam.serviceAccountUser >/dev/null
done

echo "==> Access list in Firestore (config/access)"
echo "   Add admins/allowed emails in the Firebase console → Firestore → config/access:"
echo "   { admins: [$ADMIN_EMAILS], allowedEmails: [] }  (empty allowedEmails = whole domain)"

echo "Done. Next: bash infra/deploy.sh"
