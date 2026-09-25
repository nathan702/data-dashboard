import { FieldValue, type Firestore } from "@google-cloud/firestore";
import type { Source } from "@dash/shared";
import type { RunResult, SourceState, StateStore } from "./types.js";

/**
 * Sync state lives in Firestore at sync_state/{source}. The API reads the
 * same documents to show "updated N seconds ago" without querying BigQuery.
 */
export class FirestoreStateStore implements StateStore {
  constructor(private readonly db: Firestore) {}

  private doc(source: Source) {
    return this.db.collection("sync_state").doc(source);
  }

  async get(source: Source): Promise<SourceState> {
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

  async setCursor(source: Source, entity: string, cursor: string) {
    await this.doc(source).set({ cursors: { [entity]: cursor } }, { merge: true });
  }

  async tryStartRun(source: Source, runId: string, staleAfterMs: number) {
    const ref = this.doc(source);
    return this.db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data() ?? {};
      const startedAt = d.lastRunStartedAt ? Date.parse(d.lastRunStartedAt as string) : 0;
      if (d.currentRunId && Date.now() - startedAt < staleAfterMs) return false;
      tx.set(ref, { lastRunStatus: "running", currentRunId: runId, lastRunStartedAt: new Date().toISOString() }, { merge: true });
      return true;
    });
  }

  async markRunFinished(source: Source, runId: string, result: RunResult) {
    const now = new Date().toISOString();
    // Only the run holding the claim may release it.
    const current = (await this.doc(source).get()).data()?.currentRunId;
    if (current && current !== runId) return;
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

  async releaseRun(source: Source, runId: string) {
    const d = (await this.doc(source).get()).data() ?? {};
    if (d.currentRunId !== runId) return;
    // Restore the status the source had before this run claimed it.
    await this.doc(source).set(
      { currentRunId: FieldValue.delete(), lastRunStatus: d.lastRunFinishedAt ? (d.lastError ? "error" : "ok") : FieldValue.delete() },
      { merge: true },
    );
  }

  async markDataReceived(source: Source, at: Date = new Date()) {
    await this.doc(source).set({ lastDataAt: at.toISOString() }, { merge: true });
  }
}
