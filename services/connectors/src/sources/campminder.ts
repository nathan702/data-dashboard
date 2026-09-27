import { createHash } from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import { GoogleAuth } from "google-auth-library";
import { requestJson } from "../core/http.js";
import { NotConfiguredError, requireSecret, type SecretStore } from "../core/secrets.js";
import type { Connector, RawRecord, SyncContext } from "../core/types.js";
import { reportSeason, sessionRecordId, toSessions } from "./campminderParse.js";

/**
 * Campminder has no API here: an existing automation writes its report to a
 * Google Sheet daily. This reads the sheet (shared read-only with the
 * connector's service account), keeps only allow-listed fields, and writes
 * only camper-sessions that are new, changed or gone since the last read.
 */
export const CAMPMINDER_SHEET_SECRET = "campminder-sheet-id";
export const CAMPMINDER_SEASON_SECRET = "campminder-season";
export const PSEUDONYMIZATION_SECRET = "pseudonymization-key";

export interface SheetReader {
  /** Rows of a tab, first row = headers. */
  read(sheetId: string, tab: string): Promise<string[][]>;
  /** Tab names, in sheet order. */
  tabs(sheetId: string): Promise<string[]>;
}

/** What's currently stored for a season: record id → row hash. */
export interface CurrentRows {
  load(season: number): Promise<Map<string, string>>;
}

export interface CampminderConfig {
  secrets: SecretStore;
  sheet: SheetReader;
  current: CurrentRows;
  /** Sheet id; else the campminder-sheet-id secret. */
  sheetId?: string;
  tab: string;
  /** Optional sheet of past seasons, one tab per season named by its year. */
  historySheetId?: string;
  serviceAccount?: string;
}

/** A report with far fewer rows than what's stored is probably mid-rewrite. */
const MIN_FRACTION_OF_PREVIOUS = 0.5;

export class GoogleSheetReader implements SheetReader {
  private readonly auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  constructor(private readonly serviceAccount?: string) {}

  async read(sheetId: string, tab: string): Promise<string[][]> {
    // A1 notation: quote the tab name so "2022" isn't read as a row number.
    const range = `'${tab.replace(/'/g, "''")}'`;
    const res = await this.get<{ values?: string[][] }>(sheetId, `/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, `the tab is named "${tab}"`);
    return res.values ?? [];
  }

  async tabs(sheetId: string): Promise<string[]> {
    const res = await this.get<{ sheets?: Array<{ properties?: { title?: string } }> }>(sheetId, "?fields=sheets.properties.title", "the sheet id is right");
    return (res.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  }

  private async get<T>(sheetId: string, path: string, hint: string): Promise<T> {
    const token = await (await this.auth.getClient()).getAccessToken();
    try {
      return await requestJson<T>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}${path}`, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) {
        throw new Error(
          `Can't read Campminder sheet ${sheetId}. Share it (Viewer) with ${this.serviceAccount ?? "the dashboard-connectors service account"}, and check ${hint}.`,
        );
      }
      throw err;
    }
  }
}

export class BigQueryCurrentRows implements CurrentRows {
  constructor(private readonly bq: BigQuery) {}
  async load(season: number) {
    const [rows] = await this.bq.query({
      query: `
        SELECT record_id, JSON_VALUE(payload, '$.rowHash') AS row_hash
        FROM \`raw_campminder.sessions\`
        WHERE JSON_VALUE(payload, '$.season') = CAST(@season AS STRING)
        QUALIFY ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY source_updated_at DESC, ingested_at DESC) = 1
          AND NOT is_deleted`,
      params: { season },
    });
    return new Map((rows as Array<{ record_id: string; row_hash: string }>).map((r) => [r.record_id, r.row_hash]));
  }
}

export function campminderConfigFromEnv(env: NodeJS.ProcessEnv, secrets: SecretStore): CampminderConfig {
  const project = env.GCP_PROJECT_ID;
  const sa = project ? `dashboard-connectors@${project}.iam.gserviceaccount.com` : undefined;
  return {
    secrets,
    sheet: new GoogleSheetReader(sa),
    current: new BigQueryCurrentRows(new BigQuery({ projectId: project })),
    sheetId: env.CAMPMINDER_SHEET_ID?.trim() || undefined,
    tab: env.CAMPMINDER_SHEET_TAB?.trim() || "Sheet1",
    historySheetId: env.CAMPMINDER_HISTORY_SHEET_ID?.trim() || undefined,
    serviceAccount: sa,
  };
}

export class CampminderConnector implements Connector {
  readonly source = "campminder" as const;
  constructor(private readonly cfg: CampminderConfig) {}

  async sync(ctx: SyncContext) {
    const sheetId = this.cfg.sheetId ?? (await this.cfg.secrets.get(CAMPMINDER_SHEET_SECRET));
    if (!sheetId) throw new NotConfiguredError(`Campminder isn't connected yet: set CAMPMINDER_SHEET_ID or the "${CAMPMINDER_SHEET_SECRET}" secret`);
    const key = await requireSecret(this.cfg.secrets, PSEUDONYMIZATION_SECRET, "Campminder");

    const override = Number(await this.cfg.secrets.get(CAMPMINDER_SEASON_SECRET));
    const values = await this.cfg.sheet.read(sheetId, this.cfg.tab);
    const current = await this.importSeason(ctx, key, values, {
      cursor: "sheet_hash",
      label: "The Campminder report",
      season: (rows) => (Number.isInteger(override) && override > 2000 ? override : reportSeason(rows)),
    });

    if (this.cfg.historySheetId) await this.importHistory(ctx, key, this.cfg.historySheetId, current);
  }

  /**
   * Past seasons, one tab per season named by its year ("2022"). Each tab is
   * read once and again only when it changes; removing a tab (or the sheet)
   * leaves its season as imported. The daily sheet owns its own season and
   * anything later, so a history tab can never overwrite it.
   */
  private async importHistory(ctx: SyncContext, key: string, sheetId: string, currentSeason: number | null) {
    const tabs = (await this.cfg.sheet.tabs(sheetId)).filter((t) => /^\d{4}$/.test(t.trim()));
    const problems: string[] = [];
    for (const tab of tabs.sort()) {
      const season = Number(tab.trim());
      if (currentSeason !== null && season >= currentSeason) {
        ctx.log("campminder history tab skipped: the daily sheet covers this season", { season });
        continue;
      }
      try {
        const values = await this.cfg.sheet.read(sheetId, tab);
        await this.importSeason(ctx, key, values, {
          cursor: `history_hash_${season}`,
          label: `History tab "${tab}"`,
          season: (rows) => {
            // Guards against a report pasted into the wrong tab.
            const detected = reportSeason(rows);
            if (detected && detected !== season) {
              throw new Error(`History tab "${tab}" has sessions from season ${detected}; rename the tab or check the report`);
            }
            return season;
          },
        });
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    // One bad tab doesn't hold up the others, but the run still shows as failed.
    if (problems.length) throw new Error(problems.join("; "));
  }

  /** Import one report as one season; returns the season (null when unchanged). */
  private async importSeason(
    ctx: SyncContext,
    key: string,
    values: string[][],
    opts: { cursor: string; label: string; season: (rows: Array<Record<string, string>>) => number | null },
  ): Promise<number | null> {
    const contentHash = createHash("sha256").update(JSON.stringify(values)).digest("hex");
    const lastSeason = Number(ctx.state.cursors[`${opts.cursor}_season`]) || null;
    // (Re-read once when the season wasn't saved yet, e.g. imported by an older version.)
    if (ctx.state.cursors[opts.cursor] === contentHash && lastSeason) {
      ctx.log("campminder sheet unchanged", { tab: opts.label });
      return lastSeason;
    }

    const [header, ...body] = values;
    if (!header?.includes("PersonID") || !header.includes("Child Session/Status")) {
      throw new Error(`${opts.label} is missing the "PersonID" or "Child Session/Status" column`);
    }
    const rows = body
      .filter((r) => r.some((c) => c && c.trim()))
      .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));

    const season = opts.season(rows);
    if (!season) throw new Error(`Couldn't tell which season ${opts.label.toLowerCase()} covers`);

    const sessions = toSessions(rows, key, season);
    const previous = await this.cfg.current.load(season);
    if (previous.size > 0 && sessions.length < previous.size * MIN_FRACTION_OF_PREVIOUS) {
      throw new Error(
        `${opts.label} has ${sessions.length} camper-sessions but ${previous.size} are stored for ${season}; ` +
          "it looks incomplete (maybe mid-update), so nothing was changed",
      );
    }

    const now = new Date();
    const seen = new Set<string>();
    const records: RawRecord[] = [];
    for (const s of sessions) {
      const id = sessionRecordId(s);
      seen.add(id);
      if (previous.get(id) !== s.rowHash) records.push({ entity: "sessions", recordId: id, sourceUpdatedAt: now, payload: s });
    }
    // Sessions no longer in this season's report (removed in Campminder).
    for (const id of previous.keys()) {
      if (!seen.has(id)) records.push({ entity: "sessions", recordId: id, sourceUpdatedAt: now, isDeleted: true, payload: { season } });
    }
    await ctx.emit(records);
    await ctx.saveCursor(`${opts.cursor}_season`, String(season));
    await ctx.saveCursor(opts.cursor, contentHash);
    ctx.log("campminder sheet imported", { tab: opts.label, season, campers: rows.length, sessions: sessions.length, written: records.length });
    return season;
  }
}
