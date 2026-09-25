import type { Source } from "@dash/shared";
import type { IngestPath, RawRecord, RawWriter, RunLog, RunLogEntry, RunResult, SourceState, StateStore } from "./types.js";

/** In-memory implementations for tests and `npm run sync -- --dry-run`. */
export class MemoryRawWriter implements RawWriter {
  readonly rows: Array<{ source: Source; path: IngestPath; runId: string; record: RawRecord }> = [];
  async write(source: Source, path: IngestPath, runId: string, records: RawRecord[]) {
    for (const record of records) this.rows.push({ source, path, runId, record });
    return records.length;
  }
}

export class MemoryStateStore implements StateStore {
  readonly states = new Map<Source, SourceState>();

  private s(source: Source): SourceState {
    let st = this.states.get(source);
    if (!st) {
      st = { cursors: {}, lastDataAt: null, lastSuccessAt: null, lastRunStatus: null, lastError: null };
      this.states.set(source, st);
    }
    return st;
  }

  async get(source: Source) {
    const st = this.s(source);
    return { ...st, cursors: { ...st.cursors } };
  }
  async setCursor(source: Source, entity: string, cursor: string) {
    this.s(source).cursors[entity] = cursor;
  }
  readonly running = new Map<Source, { runId: string; at: number }>();
  async tryStartRun(source: Source, runId: string, staleAfterMs: number) {
    const cur = this.running.get(source);
    if (cur && Date.now() - cur.at < staleAfterMs) return false;
    this.running.set(source, { runId, at: Date.now() });
    this.s(source).lastRunStatus = "running";
    return true;
  }
  async markRunFinished(source: Source, runId: string, result: RunResult) {
    if (this.running.get(source)?.runId === runId) this.running.delete(source);
    const st = this.s(source);
    st.lastRunStatus = result.status;
    if (result.status === "ok") {
      st.lastSuccessAt = new Date().toISOString();
      st.lastError = null;
    } else {
      st.lastError = result.error ?? "Unknown error";
    }
  }
  async markDataReceived(source: Source, at: Date = new Date()) {
    this.s(source).lastDataAt = at.toISOString();
  }
  async releaseRun(source: Source, runId: string) {
    if (this.running.get(source)?.runId === runId) this.running.delete(source);
    const st = this.s(source);
    st.lastRunStatus = st.lastSuccessAt ? "ok" : st.lastError ? "error" : null;
  }
}

export class MemoryRunLog implements RunLog {
  readonly entries: RunLogEntry[] = [];
  async record(entry: RunLogEntry) {
    this.entries.push(entry);
  }
}
