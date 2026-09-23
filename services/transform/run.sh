#!/bin/sh
# Uses the job's service account through Application Default Credentials;
# the credentials file only names the billing project and dataset location.
set -eu
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"
printf '{"projectId":"%s","location":"%s"}\n' "$GCP_PROJECT_ID" "${BQ_LOCATION:-US}" > .df-credentials.json
exec dataform run . --default-database="$GCP_PROJECT_ID" "$@"
