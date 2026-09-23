import { FieldValue, type Firestore } from "@google-cloud/firestore";
import type { BusinessLine } from "@dash/shared";
import type { RunResult, SourceState, StateStore } from "./types.js";

/**
 * Sync state lives in Firestore at sync_state/{source}. The API reads the
 * same documents to show "updated N seconds ago" without querying BigQuery.
 */
export class FirestoreStateStore implements StateStore {
  constructor(private readonly db: Firestore) {}

  private doc(source: BusinessLine) {
    return this.db.collection("sync_state").doc(source);
  }

  async get(source: BusinessLine): Promise<SourceState> {
    const snap = await this.doc(source).get();
    const d = snap.data() ?? {};
    return {
      cursors: (d.cursors as Record<string, string>) ?? {},
      lastDataAt: (d.lastDataAt as string) ?? null,
      lastSuccessAt: (d.lastSuccessAt as string) ?? null,
      lastRunStatus: (d.lastRunStatus as SourceState["lastRunStatus"]) ?? null,
      lastError: (d.lastError as string) ?? null,
    };
  }

  async setCursor(source: BusinessLine, entity: string, cursor: string) {
    await this.doc(source).set({ cursors: { [entity]: cursor } }, { merge: true });
  }

  async markRunStarted(source: BusinessLine, runId: string) {
    await this.doc(source).set(
      { lastRunStatus: "running", currentRunId: runId, lastRunStartedAt: new Date().toISOString() },
      { merge: true },
    );
  }

  async markRunFinished(source: BusinessLine, runId: string, result: RunResult) {
    const now = new Date().toISOString();
    await this.doc(source).set(
      {
        lastRunStatus: result.status,
        currentRunId: FieldValue.delete(),
        lastRunFinishedAt: now,
        lastRunId: runId,
        ...(result.status === "ok"
          ? { lastSuccessAt: now, lastError: null }
          : { lastError: result.error ?? "Unknown error", lastErrorAt: now }),
      },
      { merge: true },
    );
  }

  async markDataReceived(source: BusinessLine, at: Date = new Date()) {
    await this.doc(source).set({ lastDataAt: at.toISOString() }, { merge: true });
  }
}
