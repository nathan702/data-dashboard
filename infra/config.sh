# Project settings used by setup.sh and deploy.sh. No secrets here.
PROJECT_ID="calleva-dashboard"
REGION="us-east1"            # Cloud Run / Scheduler region (South Carolina)
BQ_LOCATION="US"             # BigQuery multi-region
WORKSPACE_DOMAIN="calleva.org"
# People who can see the admin bits (comma-separated). Everyone in the domain can view dashboards.
ADMIN_EMAILS="nathan@calleva.org"
