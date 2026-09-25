#!/usr/bin/env bash
# Build and deploy the API, connectors, transform job and web app.
# Runs automatically from GitHub Actions on pushes to the deploy branches
# (see .github/workflows/ci.yml); can also be run by hand:  bash infra/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.sh
gcloud config set project "$PROJECT_ID" >/dev/null

API_SA="dashboard-api@$PROJECT_ID.iam.gserviceaccount.com"
CONN_SA="dashboard-connectors@$PROJECT_ID.iam.gserviceaccount.com"
XFORM_SA="dashboard-transform@$PROJECT_ID.iam.gserviceaccount.com"
SCHED_SA="dashboard-scheduler@$PROJECT_ID.iam.gserviceaccount.com"
REPO="$REGION-docker.pkg.dev/$PROJECT_ID/dashboard"

TAG=$(git rev-parse --short HEAD)
echo "==> Building images ($TAG)"
if [ "${DEPLOY_BUILDER:-cloudbuild}" = "docker" ]; then
  # GitHub Actions builds locally and pushes to Artifact Registry.
  gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
  for img in api connectors transform; do
    docker build -q -f "services/$img/Dockerfile" -t "$REPO/$img:$TAG" .
    docker push -q "$REPO/$img:$TAG"
  done
else
  gcloud builds submit --config=infra/cloudbuild.yaml --substitutions=_REPO="$REPO",_TAG="$TAG" .
fi

echo "==> API"
# Firebase Hosting's /api rewrite calls Cloud Run without credentials, so the
# service must allow unauthenticated invocation. The API itself rejects any
# /api request without a valid Workspace sign-in token.
gcloud run deploy dashboard-api --image="$REPO/api:$TAG" --region="$REGION" \
  --service-account="$API_SA" --allow-unauthenticated \
  --min-instances=0 --max-instances=3 --memory=512Mi \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,ALLOWED_DOMAINS=$WORKSPACE_DOMAIN,BQ_MARTS_DATASET=marts,BQ_LOCATION=$BQ_LOCATION,TRANSFORM_JOB=projects/$PROJECT_ID/locations/$REGION/jobs/dashboard-transform"

echo "==> Connectors: webhooks (public, signature-checked) and scheduled jobs (private)"
# Cloud Run's deterministic URL, known before the first deploy; it's part of Square's signatures.
WEBHOOK_BASE_URL="https://dashboard-connectors-webhooks-$PROJECT_NUMBER.$REGION.run.app"
COMMON_ENV="GCP_PROJECT_ID=$PROJECT_ID,BQ_LOCATION=$BQ_LOCATION,PUBLIC_WEBHOOK_BASE_URL=$WEBHOOK_BASE_URL"
gcloud run deploy dashboard-connectors-webhooks --image="$REPO/connectors:$TAG" --region="$REGION" \
  --service-account="$CONN_SA" --allow-unauthenticated \
  --min-instances=0 --max-instances=5 --memory=512Mi \
  --set-env-vars="$COMMON_ENV,SERVICE_ROLE=webhooks"
gcloud run deploy dashboard-connectors-jobs --image="$REPO/connectors:$TAG" --region="$REGION" \
  --service-account="$CONN_SA" --no-allow-unauthenticated --timeout=1800 \
  --min-instances=0 --max-instances=2 --memory=1Gi \
  --set-env-vars="$COMMON_ENV,SERVICE_ROLE=jobs"
gcloud run services add-iam-policy-binding dashboard-connectors-jobs --region="$REGION" \
  --member="serviceAccount:$SCHED_SA" --role=roles/run.invoker >/dev/null
JOBS_URL=$(gcloud run services describe dashboard-connectors-jobs --region="$REGION" --format='value(status.url)')

# Sources without credentials yet just report "not connected", so every source is scheduled.
for SRC in shopify square; do
  if gcloud scheduler jobs describe "sync-$SRC" --location="$REGION" >/dev/null 2>&1; then SCHED_CMD=update; else SCHED_CMD=create; fi
  gcloud scheduler jobs "$SCHED_CMD" http "sync-$SRC" --location="$REGION" \
    --schedule="*/15 * * * *" --time-zone="America/New_York" \
    --uri="$JOBS_URL/run/$SRC" --http-method=POST --attempt-deadline=30m \
    --oidc-service-account-email="$SCHED_SA" --oidc-token-audience="$JOBS_URL" >/dev/null
done

echo "==> SQL transforms (Cloud Run job, every 15 minutes)"
gcloud run jobs deploy dashboard-transform --image="$REPO/transform:$TAG" --region="$REGION" \
  --service-account="$XFORM_SA" --task-timeout=1800 --max-retries=1 --memory=1Gi \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,BQ_LOCATION=$BQ_LOCATION"
gcloud run jobs add-iam-policy-binding dashboard-transform --region="$REGION" \
  --member="serviceAccount:$SCHED_SA" --role=roles/run.invoker >/dev/null
# Saving assignments on the Settings page starts a refresh right away.
gcloud run jobs add-iam-policy-binding dashboard-transform --region="$REGION" \
  --member="serviceAccount:$API_SA" --role=roles/run.invoker >/dev/null
JOB_URI="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/dashboard-transform:run"
if gcloud scheduler jobs describe dashboard-transform --location="$REGION" >/dev/null 2>&1; then SCHED_CMD=update; else SCHED_CMD=create; fi
gcloud scheduler jobs "$SCHED_CMD" http dashboard-transform --location="$REGION" \
  --schedule="*/15 * * * *" --time-zone="America/New_York" \
  --uri="$JOB_URI" --http-method=POST --oauth-service-account-email="$SCHED_SA"
# Build the tables once now rather than waiting for the first scheduled run.
TRANSFORM_OK=1
gcloud run jobs execute dashboard-transform --region="$REGION" --wait || TRANSFORM_OK=0

echo "==> Web app"
npm ci
npm run build -w packages/shared
npm run build -w apps/web
npx -y firebase-tools@latest deploy --only hosting,firestore:rules --project "$PROJECT_ID"

echo "==> Checking the live API against the tables"
API_URL=$(gcloud run services describe dashboard-api --region="$REGION" --format='value(status.url)')
FAILED=0
if [ "$TRANSFORM_OK" != 1 ]; then
  echo "   FAILED: the SQL transform run failed. Logs: Cloud Run → Jobs → dashboard-transform → Logs"
  FAILED=1
fi
CHECK=$(curl -sS --max-time 180 "$API_URL/healthz/deep" || echo '{"ok":false,"checks":[{"name":"reach API","ok":false}]}')
echo "$CHECK" | jq -r '.checks[] | "   \(if .ok then "ok  " else "FAIL" end)  \(.name)\(if .detail then " — \(.detail)" else "" end)"'
echo "$CHECK" | jq -e '.ok' >/dev/null || FAILED=1
if [ "$FAILED" = 1 ]; then
  echo "Deploy finished, but checks failed (see above)."
  exit 1
fi
echo "All checks passed."
