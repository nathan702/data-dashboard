import type { BusinessLine } from "@dash/shared";
import type { IngestPath, RawRecord, RawWriter, RunLog, RunLogEntry, RunResult, SourceState, StateStore } from "./types.js";

/** In-memory implementations for tests and `npm run sync -- --dry-run`. */
export class MemoryRawWriter implements RawWriter {
  readonly rows: Array<{ source: BusinessLine; path: IngestPath; runId: string; record: RawRecord }> = [];
  async write(source: BusinessLine, path: IngestPath, runId: string, records: RawRecord[]) {
    for (const record of records) this.rows.push({ source, path, runId, record });
    return records.length;
  }
}

export class MemoryStateStore implements StateStore {
  readonly states = new Map<BusinessLine, SourceState>();

  private s(source: BusinessLine): SourceState {
    let st = this.states.get(source);
    if (!st) {
      st = { cursors: {}, lastDataAt: null, lastSuccessAt: null, lastRunStatus: null, lastError: null };
      this.states.set(source, st);
    }
    return st;
  }

  async get(source: BusinessLine) {
    const st = this.s(source);
    return { ...st, cursors: { ...st.cursors } };
  }
  async setCursor(source: BusinessLine, entity: string, cursor: string) {
    this.s(source).cursors[entity] = cursor;
  }
  async markRunStarted(source: BusinessLine) {
    this.s(source).lastRunStatus = "running";
  }
  async markRunFinished(source: BusinessLine, _runId: string, result: RunResult) {
    const st = this.s(source);
    st.lastRunStatus = result.status;
    if (result.status === "ok") {
      st.lastSuccessAt = new Date().toISOString();
      st.lastError = null;
    } else {
      st.lastError = result.error ?? "Unknown error";
    }
  }
  async markDataReceived(source: BusinessLine, at: Date = new Date()) {
    this.s(source).lastDataAt = at.toISOString();
  }
}

export class MemoryRunLog implements RunLog {
  readonly entries: RunLogEntry[] = [];
  async record(entry: RunLogEntry) {
    this.entries.push(entry);
  }
}
