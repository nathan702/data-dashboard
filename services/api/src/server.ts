import { BigQuery } from "@google-cloud/bigquery";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createApi } from "./app.js";
import type { AccessList, AuthDeps } from "./auth.js";
import { loadConfig } from "./config.js";
import { FirestoreFreshness } from "./freshness.js";
import { FirestorePreferences, MemoryPreferences } from "./preferences.js";
import { CloudRunJobTrigger, NoopTrigger } from "./refresh.js";
import { BigQueryWarehouse } from "./warehouse/bigquery.js";
import { DemoFreshness, DemoWarehouse } from "./warehouse/demo.js";

const config = loadConfig();
const needsFirebase = !config.authDisabled || !config.demoData;
const firebase = needsFirebase ? initializeApp(config.projectId ? { projectId: config.projectId } : undefined) : null;

let auth: AuthDeps | null = null;
if (!config.authDisabled && firebase) {
  const db = getFirestore(firebase);
  let accessCache: { at: number; value: AccessList } | null = null;
  auth = {
    allowedDomains: config.allowedDomains,
    verifyIdToken: (t) => getAuth(firebase).verifyIdToken(t, true),
    // Access list is edited in Firestore at config/access; cached for a minute.
    async loadAccessList() {
      if (accessCache && Date.now() - accessCache.at < 60_000) return accessCache.value;
      const d = (await db.collection("config").doc("access").get()).data() ?? {};
      const value = { allowedEmails: (d.allowedEmails as string[]) ?? [], admins: (d.admins as string[]) ?? [] };
      accessCache = { at: Date.now(), value };
      return value;
    },
  };
}

const app = createApi({
  auth,
  warehouse: config.demoData
    ? new DemoWarehouse()
    : new BigQueryWarehouse(new BigQuery({ projectId: config.projectId }), config.martsDataset, config.configDataset, config.bqLocation),
  freshness: config.demoData || !firebase ? new DemoFreshness() : new FirestoreFreshness(getFirestore(firebase)),
  preferences: config.demoData || !firebase ? new MemoryPreferences() : new FirestorePreferences(getFirestore(firebase)),
  refresh: config.transformJob && !config.demoData ? new CloudRunJobTrigger(config.transformJob) : new NoopTrigger(),
  corsOrigins: config.corsOrigins,
  cacheTtlSeconds: config.cacheTtlSeconds,
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(JSON.stringify({ severity: "INFO", message: "api listening", port, demo: config.demoData })));
