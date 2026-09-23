#!/usr/bin/env bash
# Build and deploy the API, connectors and web app.  bash infra/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.sh
gcloud config set project "$PROJECT_ID" >/dev/null

API_SA="dashboard-api@$PROJECT_ID.iam.gserviceaccount.com"
CONN_SA="dashboard-connectors@$PROJECT_ID.iam.gserviceaccount.com"
SCHED_SA="dashboard-scheduler@$PROJECT_ID.iam.gserviceaccount.com"
REPO="$REGION-docker.pkg.dev/$PROJECT_ID/dashboard"

gcloud artifacts repositories describe dashboard --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create dashboard --repository-format=docker --location="$REGION"

TAG=$(git rev-parse --short HEAD)
echo "==> Building images ($TAG)"
gcloud builds submit --config=infra/cloudbuild.yaml --substitutions=_REPO="$REPO",_TAG="$TAG" .

echo "==> API"
# Firebase Hosting's /api rewrite calls Cloud Run without credentials, so the
# service must allow unauthenticated invocation. The API itself rejects any
# /api request without a valid Workspace sign-in token.
gcloud run deploy dashboard-api --image="$REPO/api:$TAG" --region="$REGION" \
  --service-account="$API_SA" --allow-unauthenticated \
  --min-instances=0 --max-instances=3 --memory=512Mi \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,ALLOWED_DOMAINS=$WORKSPACE_DOMAIN,BQ_MARTS_DATASET=marts"

echo "==> Connectors: scheduled jobs (private) and webhooks (public, signature-checked)"
COMMON_ENV="GCP_PROJECT_ID=$PROJECT_ID,BQ_LOCATION=$BQ_LOCATION"
gcloud run deploy dashboard-connectors-jobs --image="$REPO/connectors:$TAG" --region="$REGION" \
  --service-account="$CONN_SA" --no-allow-unauthenticated --timeout=3600 \
  --min-instances=0 --max-instances=2 --memory=1Gi \
  --set-env-vars="$COMMON_ENV,SERVICE_ROLE=jobs"
gcloud run services add-iam-policy-binding dashboard-connectors-jobs --region="$REGION" \
  --member="serviceAccount:$SCHED_SA" --role=roles/run.invoker >/dev/null
gcloud run deploy dashboard-connectors-webhooks --image="$REPO/connectors:$TAG" --region="$REGION" \
  --service-account="$CONN_SA" --allow-unauthenticated \
  --min-instances=0 --max-instances=5 --memory=512Mi \
  --set-env-vars="$COMMON_ENV,SERVICE_ROLE=webhooks"

echo "==> Web app"
npm ci
npm run build -w packages/shared
npm run build -w apps/web
npx -y firebase-tools@latest deploy --only hosting,firestore:rules --project "$PROJECT_ID"
