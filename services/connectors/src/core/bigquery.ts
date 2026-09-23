import { BigQuery, type Table } from "@google-cloud/bigquery";
import type { BusinessLine } from "@dash/shared";
import type { IngestPath, RawRecord, RawWriter, RunLog, RunLogEntry } from "./types.js";

/** Every raw table has the same shape; the platform payload is kept as JSON. */
export const RAW_TABLE_SCHEMA = [
  { name: "record_id", type: "STRING", mode: "REQUIRED" },
  { name: "source_updated_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "sync_run_id", type: "STRING", mode: "REQUIRED" },
  { name: "ingest_path", type: "STRING", mode: "REQUIRED" },
  { name: "is_deleted", type: "BOOL", mode: "REQUIRED" },
  { name: "payload", type: "JSON", mode: "NULLABLE" },
];

export const SYNC_RUNS_SCHEMA = [
  { name: "run_id", type: "STRING", mode: "REQUIRED" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "mode", type: "STRING", mode: "REQUIRED" },
  { name: "started_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "finished_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "status", type: "STRING", mode: "REQUIRED" },
  { name: "rows_written", type: "INT64", mode: "REQUIRED" },
  { name: "error", type: "STRING", mode: "NULLABLE" },
];

const INSERT_BATCH = 500;

export function rawDataset(source: BusinessLine): string {
  return `raw_${source}`;
}

/** BigQuery table names allow letters, digits and underscores. */
export function rawTableName(entity: string): string {
  const name = entity.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z_]/.test(name)) throw new Error(`Invalid entity name: ${entity}`);
  return name;
}

export function toRawRow(record: RawRecord, path: IngestPath, runId: string, now: Date) {
  return {
    record_id: record.recordId,
    source_updated_at: (record.sourceUpdatedAt ?? now).toISOString(),
    ingested_at: now.toISOString(),
    sync_run_id: runId,
    ingest_path: path,
    is_deleted: record.isDeleted ?? false,
    payload: JSON.stringify(record.payload ?? null),
  };
}

export class BigQueryRawWriter implements RawWriter {
  private readonly ready = new Map<string, Promise<Table>>();

  constructor(
    private readonly bq: BigQuery,
    private readonly location = "US",
  ) {}

  async write(source: BusinessLine, path: IngestPath, runId: string, records: RawRecord[]): Promise<number> {
    const now = new Date();
    const byEntity = new Map<string, RawRecord[]>();
    for (const r of records) {
      const list = byEntity.get(r.entity) ?? [];
      list.push(r);
      byEntity.set(r.entity, list);
    }
    for (const [entity, list] of byEntity) {
      const table = await this.table(rawDataset(source), rawTableName(entity));
      for (let i = 0; i < list.length; i += INSERT_BATCH) {
        const rows = list.slice(i, i + INSERT_BATCH).map((r) => ({
          // insertId lets BigQuery drop exact retries; staging dedups the rest.
          insertId: `${r.recordId}:${(r.sourceUpdatedAt ?? now).toISOString()}:${r.isDeleted ? 1 : 0}`,
          json: toRawRow(r, path, runId, now),
        }));
        await table.insert(rows, { raw: true });
      }
    }
    return records.length;
  }

  /** Create the dataset/table on first use so new entities need no manual setup. */
  private table(datasetId: string, tableId: string): Promise<Table> {
    const key = `${datasetId}.${tableId}`;
    let p = this.ready.get(key);
    if (!p) {
      p = this.ensureTable(datasetId, tableId);
      p.catch(() => this.ready.delete(key));
      this.ready.set(key, p);
    }
    return p;
  }

  private async ensureTable(datasetId: string, tableId: string): Promise<Table> {
    const dataset = this.bq.dataset(datasetId);
    const [datasetExists] = await dataset.exists();
    if (!datasetExists) await dataset.create({ location: this.location }).catch(ignoreAlreadyExists);
    const table = dataset.table(tableId);
    const [tableExists] = await table.exists();
    if (!tableExists) {
      await table
        .create({
          schema: { fields: RAW_TABLE_SCHEMA },
          timePartitioning: { type: "DAY", field: "ingested_at" },
          clustering: { fields: ["record_id"] },
        })
        .catch(ignoreAlreadyExists);
    }
    return table;
  }
}

export class BigQueryRunLog implements RunLog {
  constructor(private readonly bq: BigQuery) {}

  async record(e: RunLogEntry): Promise<void> {
    await this.bq
      .dataset("ops")
      .table("sync_runs")
      .insert(
        [
          {
            run_id: e.runId,
            source: e.source,
            mode: e.mode,
            started_at: e.startedAt.toISOString(),
            finished_at: e.finishedAt.toISOString(),
            status: e.status,
            rows_written: e.rowsWritten,
            error: e.error,
          },
        ],
        { ignoreUnknownValues: false },
      );
  }
}

function ignoreAlreadyExists(err: unknown) {
  if ((err as { code?: number }).code === 409) return;
  throw err;
}
