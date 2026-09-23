import { BigQuery } from "@google-cloud/bigquery";
import { Firestore } from "@google-cloud/firestore";
import { BigQueryRawWriter, BigQueryRunLog } from "./core/bigquery.js";
import { FirestoreStateStore } from "./core/firestoreState.js";
import { MemoryRawWriter, MemoryRunLog, MemoryStateStore } from "./core/memory.js";
import type { Deps } from "./core/runner.js";

export function createDeps(opts: { dryRun?: boolean } = {}): Deps {
  if (opts.dryRun) {
    return { writer: new MemoryRawWriter(), state: new MemoryStateStore(), runLog: new MemoryRunLog() };
  }
  const projectId = process.env.GCP_PROJECT_ID;
  const bq = new BigQuery({ projectId });
  return {
    writer: new BigQueryRawWriter(bq, process.env.BQ_LOCATION ?? "US"),
    state: new FirestoreStateStore(new Firestore({ projectId })),
    runLog: new BigQueryRunLog(bq),
  };
}
