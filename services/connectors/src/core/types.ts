import type { Source } from "@dash/shared";

/** How a record reached us. Kept on every raw row for debugging. */
export type IngestPath = "webhook" | "poll" | "backfill" | "file" | "email";

/**
 * One record from a source platform, stored as-is in raw_<source>.<entity>.
 * Staging models keep the latest version per record_id.
 */
export interface RawRecord {
  entity: string;
  recordId: string;
  /** When the source says the record last changed (falls back to ingest time). */
  sourceUpdatedAt?: Date;
  isDeleted?: boolean;
  payload: unknown;
}

export interface RawWriter {
  write(source: Source, path: IngestPath, runId: string, records: RawRecord[]): Promise<number>;
}

export interface SourceState {
  /** Opaque per-entity cursors, e.g. { orders: "2026-09-23T12:00:00Z" }. */
  cursors: Record<string, string>;
  lastDataAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: "ok" | "running" | "error" | null;
  lastError: string | null;
}

export interface StateStore {
  get(source: Source): Promise<SourceState>;
  setCursor(source: Source, entity: string, cursor: string): Promise<void>;
  /**
   * Atomically claim the source for a run. Returns false if another run holds
   * it and started less than `staleAfterMs` ago (a crashed run's claim expires).
   */
  tryStartRun(source: Source, runId: string, staleAfterMs: number): Promise<boolean>;
  markRunFinished(source: Source, runId: string, result: RunResult): Promise<void>;
  /** Drop the run claim without recording a result. */
  releaseRun(source: Source, runId: string): Promise<void>;
  markDataReceived(source: Source, at?: Date): Promise<void>;
}

export interface RunResult {
  status: "ok" | "error";
  rowsWritten: number;
  error?: string;
}

export interface RunLog {
  record(entry: RunLogEntry): Promise<void>;
}

export interface RunLogEntry {
  runId: string;
  source: Source;
  mode: SyncMode;
  startedAt: Date;
  finishedAt: Date;
  status: "ok" | "error";
  rowsWritten: number;
  error: string | null;
}

/** incremental: since stored cursors. backfill: all history. */
export type SyncMode = "incremental" | "backfill";

export interface SyncContext {
  runId: string;
  mode: SyncMode;
  state: SourceState;
  /** Write a batch of records and return how many were written. */
  emit(records: RawRecord[]): Promise<number>;
  /** Persist a cursor as soon as the data before it is safely written. */
  saveCursor(entity: string, cursor: string): Promise<void>;
  log(message: string, fields?: Record<string, unknown>): void;
  /**
   * True once the run is close to its time limit. Long imports (full history)
   * check this between pages, save their cursor and stop; the next scheduled
   * run picks up where this one left off.
   */
  outOfTime(): boolean;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  /** The exact bytes received; signatures are computed over these. */
  rawBody: Buffer;
  /** Full public URL the platform posted to (some signatures include it). */
  url: string;
}

export interface Connector {
  source: Source;
  /** Pull from the source. Called by Cloud Scheduler and for backfills. */
  sync?(ctx: SyncContext): Promise<void>;
  /**
   * Handle a push from the source. Must verify authenticity and throw
   * WebhookAuthError if it can't. Returns records to store.
   */
  handleWebhook?(req: WebhookRequest): Promise<RawRecord[]>;
}

export class WebhookAuthError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookAuthError";
  }
}
