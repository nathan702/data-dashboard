import type { Firestore } from "firebase-admin/firestore";
import { BUSINESS_LINES, type SourceFreshness, type SyncStatus } from "@dash/shared";
import type { FreshnessSource } from "./warehouse/types.js";

/** Reads the sync_state documents the connectors maintain. */
export class FirestoreFreshness implements FreshnessSource {
  constructor(private readonly db: Firestore) {}

  async freshness(): Promise<SourceFreshness[]> {
    const snaps = await this.db.getAll(...BUSINESS_LINES.map((s) => this.db.collection("sync_state").doc(s)));
    return snaps.map((snap, i) => {
      const d = snap.data();
      const source = BUSINESS_LINES[i]!;
      if (!d) return { source, status: "never_run", lastDataAt: null, lastSuccessAt: null, lastError: null };
      return {
        source,
        status: (d.lastRunStatus as SyncStatus | undefined) ?? "never_run",
        lastDataAt: (d.lastDataAt as string | undefined) ?? null,
        lastSuccessAt: (d.lastSuccessAt as string | undefined) ?? null,
        lastError: (d.lastError as string | undefined) ?? null,
      };
    });
  }
}
