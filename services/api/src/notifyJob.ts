import { BigQuery } from "@google-cloud/bigquery";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreFreshness } from "./freshness.js";
import { FirestoreAlertState, FirestoreNotifications } from "./notifications.js";
import { runNotifications } from "./notify.js";
import { FirestoreSeasonSettings } from "./seasons.js";
import { SlackMessenger, slackTokenFromSecretManager } from "./slack.js";
import { FirestoreTargets } from "./targets.js";
import { BigQueryWarehouse } from "./warehouse/bigquery.js";

/**
 * The hourly notifications job (Cloud Run job dashboard-digest, started by
 * Cloud Scheduler): digests due this hour and alerts that fired, as Slack
 * direct messages. Runs the API's own code, so its numbers match the dashboard.
 */
const env = process.env;
const projectId = env.GCP_PROJECT_ID;
const firebase = initializeApp(projectId ? { projectId } : undefined);
const db = getFirestore(firebase);

const summary = await runNotifications({
  warehouse: new BigQueryWarehouse(new BigQuery({ projectId }), env.BQ_MARTS_DATASET ?? "marts", env.BQ_CONFIG_DATASET ?? "config", env.BQ_LOCATION ?? "US"),
  freshness: new FirestoreFreshness(db),
  seasons: new FirestoreSeasonSettings(db),
  targets: new FirestoreTargets(db),
  notifications: new FirestoreNotifications(db),
  alertState: new FirestoreAlertState(db),
  messenger: new SlackMessenger(slackTokenFromSecretManager(projectId)),
  appUrl: env.APP_URL ?? "https://data.calleva.org",
});
// Counts only: no addresses or numbers in the log.
console.log(JSON.stringify({ severity: "INFO", message: "notifications run", ...summary }));
if ((summary.results.failed ?? 0) > 0) process.exitCode = 1;
