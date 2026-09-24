import { randomUUID } from "node:crypto";
import type { Connector, RawWriter, RunLog, StateStore, SyncMode, WebhookRequest } from "./types.js";
import { logger } from "./logger.js";
import { NotConfiguredError } from "./secrets.js";

export interface Deps {
  writer: RawWriter;
  state: StateStore;
  runLog: RunLog;
}

export function newRunId(): string {
  return randomUUID();
}

/**
 * Run one scheduled or backfill sync. Records the outcome in Firestore (for
 * the freshness badges) and BigQuery ops.sync_runs (for history). Never
 * throws for connector errors; the result says what happened.
 */
/**
 * Cloud Scheduler waits at most 30 minutes for a response, so each run stops
 * pulling new pages after 25. Long imports continue on the next run.
 */
export const DEFAULT_RUN_BUDGET_MS = 25 * 60_000;

export async function runSync(connector: Connector, deps: Deps, mode: SyncMode, budgetMs = DEFAULT_RUN_BUDGET_MS) {
  if (!connector.sync) throw new Error(`${connector.source} does not support scheduled sync`);
  const runId = newRunId();
  const startedAt = new Date();
  const source = connector.source;
  const log = logger.child({ source, runId, mode });
  let rowsWritten = 0;

  // A scheduled run can fire while a long history import is still going.
  if (!(await deps.state.tryStartRun(source, runId, budgetMs + 10 * 60_000))) {
    log.info("skipped: previous run still in progress");
    return { runId, status: "ok" as const, rowsWritten: 0, skipped: true };
  }
  const state = await deps.state.get(source);
  log.info("sync started");

  let status: "ok" | "error" = "ok";
  let error: string | null = null;
  try {
    await connector.sync({
      runId,
      mode,
      state,
      emit: async (records) => {
        if (records.length === 0) return 0;
        const n = await deps.writer.write(source, mode === "backfill" ? "backfill" : "poll", runId, records);
        rowsWritten += n;
        await deps.state.markDataReceived(source);
        return n;
      },
      saveCursor: (entity, cursor) => deps.state.setCursor(source, entity, cursor),
      log: (message, fields) => log.info(message, fields),
      outOfTime: () => Date.now() - startedAt.getTime() > budgetMs,
    });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      // Credentials not added yet: leave the source as "Not connected".
      await deps.state.releaseRun(source, runId);
      log.info("skipped: not configured", { reason: err.message });
      return { runId, status: "ok" as const, rowsWritten: 0, skipped: true, notConfigured: true };
    }
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    log.error("sync failed", { error, stack: err instanceof Error ? err.stack : undefined });
  }

  const result = { status, rowsWritten, ...(error ? { error } : {}) };
  await deps.state.markRunFinished(source, runId, result);
  await deps.runLog
    .record({ runId, source, mode, startedAt, finishedAt: new Date(), status, rowsWritten, error })
    .catch((err) => log.error("failed to write run log", { error: String(err) }));
  log.info("sync finished", { status, rowsWritten });
  return { runId, ...result };
}

/** Verify and store one webhook delivery. Throws WebhookAuthError on bad signatures. */
export async function handleWebhook(connector: Connector, deps: Deps, req: WebhookRequest) {
  if (!connector.handleWebhook) throw new Error(`${connector.source} does not accept webhooks`);
  const records = await connector.handleWebhook(req);
  const n = records.length ? await deps.writer.write(connector.source, "webhook", `webhook:${newRunId()}`, records) : 0;
  if (n > 0) await deps.state.markDataReceived(connector.source);
  return n;
}
