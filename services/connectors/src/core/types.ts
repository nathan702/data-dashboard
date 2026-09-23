import type { BusinessLine } from "@dash/shared";

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
  write(source: BusinessLine, path: IngestPath, runId: string, records: RawRecord[]): Promise<number>;
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
  get(source: BusinessLine): Promise<SourceState>;
  setCursor(source: BusinessLine, entity: string, cursor: string): Promise<void>;
  markRunStarted(source: BusinessLine, runId: string): Promise<void>;
  markRunFinished(source: BusinessLine, runId: string, result: RunResult): Promise<void>;
  markDataReceived(source: BusinessLine, at?: Date): Promise<void>;
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
  source: BusinessLine;
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
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  /** The exact bytes received; signatures are computed over these. */
  rawBody: Buffer;
  /** Full public URL the platform posted to (some signatures include it). */
  url: string;
}

export interface Connector {
  source: BusinessLine;
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
