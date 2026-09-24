#!/usr/bin/env bash
# One-time (and safe to re-run) Google Cloud setup for the dashboard.
# Prerequisites: gcloud CLI signed in as a project owner, billing enabled.
#   (settings live in infra/config.sh)
#   bash infra/setup.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  bigquery.googleapis.com firestore.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com \
  identitytoolkit.googleapis.com gmail.googleapis.com storage.googleapis.com

echo "==> Firestore (native mode)"
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 \
  || gcloud firestore databases create --location=nam5 --type=firestore-native

echo "==> BigQuery datasets"
for ds in raw_campminder raw_fareharbor raw_hubspot raw_shopify raw_square staging marts ops dataform_assertions; do
  bq --location="$BQ_LOCATION" show "$PROJECT_ID:$ds" >/dev/null 2>&1 \
    || bq --location="$BQ_LOCATION" mk --dataset "$PROJECT_ID:$ds"
done
bq show "$PROJECT_ID:ops.sync_runs" >/dev/null 2>&1 || bq mk --table \
  --time_partitioning_field started_at --time_partitioning_type DAY \
  "$PROJECT_ID:ops.sync_runs" \
  run_id:STRING,source:STRING,mode:STRING,started_at:TIMESTAMP,finished_at:TIMESTAMP,status:STRING,rows_written:INT64,error:STRING

echo "==> Raw tables (created empty so the SQL transforms run before a source is connected)"
# Must match RAW_TABLE_SCHEMA in services/connectors/src/core/bigquery.ts
RAW_TABLES="raw_shopify.orders raw_shopify.products raw_shopify.inventory_levels
  raw_square.locations raw_square.catalog_objects raw_square.orders raw_square.payments raw_square.refunds"
for t in $RAW_TABLES; do
  bq show "$PROJECT_ID:$t" >/dev/null 2>&1 || bq mk --table \
    --time_partitioning_field ingested_at --time_partitioning_type DAY --clustering_fields record_id \
    "$PROJECT_ID:$t" ./raw_table_schema.json >/dev/null
done

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

bind() { gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$1" --role="$2" --condition=None >/dev/null; }
# API: run queries, read marts only, read Firestore sync state/access list, verify sign-ins.
bind "$API_SA" roles/bigquery.jobUser
bind "$API_SA" roles/datastore.viewer
bind "$API_SA" roles/firebaseauth.viewer
bq add-iam-policy-binding --member="serviceAccount:$API_SA" --role=roles/bigquery.dataViewer "$PROJECT_ID:marts" >/dev/null
# Connectors: write raw_* and ops, keep sync state, read their secrets.
bind "$CONN_SA" roles/bigquery.jobUser
bind "$CONN_SA" roles/datastore.user
for ds in raw_campminder raw_fareharbor raw_hubspot raw_shopify raw_square ops; do
  bq add-iam-policy-binding --member="serviceAccount:$CONN_SA" --role=roles/bigquery.dataEditor "$PROJECT_ID:$ds" >/dev/null
done
bind "$CONN_SA" roles/secretmanager.secretAccessor
# Transforms: read raw_* and ops, rebuild staging/marts and run assertions.
bind "$XFORM_SA" roles/bigquery.jobUser
for ds in raw_campminder raw_fareharbor raw_hubspot raw_shopify raw_square ops; do
  bq add-iam-policy-binding --member="serviceAccount:$XFORM_SA" --role=roles/bigquery.dataViewer "$PROJECT_ID:$ds" >/dev/null
done
for ds in staging marts dataform_assertions; do
  bq add-iam-policy-binding --member="serviceAccount:$XFORM_SA" --role=roles/bigquery.dataEditor "$PROJECT_ID:$ds" >/dev/null
done

echo "==> Secrets (values are added later with: echo -n VALUE | gcloud secrets versions add NAME --data-file=-)"
for s in pseudonymization-key shopify-shop shopify-client-id shopify-client-secret square-access-token square-webhook-signature-key hubspot-private-app-token hubspot-client-secret; do
  gcloud secrets describe "$s" >/dev/null 2>&1 || gcloud secrets create "$s" --replication-policy=automatic
done
if [ "$(gcloud secrets versions list pseudonymization-key --format='value(name)' | wc -l)" = "0" ]; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add pseudonymization-key --data-file=- >/dev/null
  echo "   generated pseudonymization-key"
fi

# Connectors save the Square webhook signing key themselves when they create the subscription.
gcloud secrets add-iam-policy-binding square-webhook-signature-key \
  --member="serviceAccount:$CONN_SA" --role=roles/secretmanager.secretVersionAdder >/dev/null

echo "==> Access list in Firestore (config/access)"
echo "   Add admins/allowed emails in the Firebase console → Firestore → config/access:"
echo "   { admins: [$ADMIN_EMAILS], allowedEmails: [] }  (empty allowedEmails = whole domain)"

echo "Done. Next: bash infra/deploy.sh"
