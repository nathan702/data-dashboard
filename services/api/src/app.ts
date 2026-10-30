import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { LRUCache } from "lru-cache";
import {
  assignmentUpdateSchema,
  draftProgramFamily,
  programFamilySettingsSchema,
  cleanSchool,
  applySchoolAction,
  BUILTIN_SCHOOLS,
  EMPTY_SCHOOL_SETTINGS,
  readSchoolSettings,
  resolveSchoolSpellings,
  schoolActionSchema,
  SchoolMatcher,
  type OfficialSchool,
  type SchoolResolution,
  REPORT_DATASET_INFO,
  reportSpecSchema,
  reportValuesQuerySchema,
  savedReportInputSchema,
  STARTER_REPORTS,
  type SavedReport,
  CALENDAR_YEAR,
  campminderCalendar,
  isBusinessLine,
  lineCalendar,
  seasonSettingsSchema,
  type SeasonSettings,
  enrollmentBreakdownQuerySchema,
  enrollmentMapQuerySchema,
  enrollmentSeasonsQuerySchema,
  enrollmentSummaryQuerySchema,
  type BusinessLineOrUnassigned,
  type EnrollmentBreakdownQuery,
  type EnrollmentMapQuery,
  type EnrollmentSummaryQuery,
  isBusinessLineOrUnassigned,
  isRetailSource,
  isSource,
  preferencesSchema,
  retailBreakdownQuerySchema,
  retailKpiQuerySchema,
  revenueQuerySchema,
  type AssignmentsResponse,
  type MeResponse,
} from "@dash/shared";
import { requireAdmin, requireViewer, type AuthDeps } from "./auth.js";
import { runSelfCheck } from "./selfCheck.js";
import type { PreferencesStore } from "./preferences.js";
import type { SeasonSettingsStore } from "./seasons.js";
import type { ProgramFamilyStore, ReportStore, SchoolStore } from "./reports.js";
import type { RefreshTrigger } from "./refresh.js";
import type { FreshnessSource, Warehouse } from "./warehouse/types.js";

export interface ApiOptions {
  /** null disables auth (local development only). */
  auth: AuthDeps | null;
  warehouse: Warehouse;
  freshness: FreshnessSource;
  preferences: PreferencesStore;
  seasons: SeasonSettingsStore;
  reports: ReportStore;
  programFamilies: ProgramFamilyStore;
  schools: SchoolStore;
  /** The official school directory (empty until fetched). */
  officialSchools: OfficialSchool[];
  refresh: RefreshTrigger;
  corsOrigins: string[];
  cacheTtlSeconds: number;
}

const csv = (v: unknown) => (typeof v === "string" && v ? v.split(",") : undefined);

export function createApi(opts: ApiOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // Short-lived cache: the same dashboard opened by several people only
  // queries BigQuery once per TTL, which keeps costs close to zero.
  const cache = new LRUCache<string, object>({ max: 500, ttl: opts.cacheTtlSeconds * 1000 });
  const cached = async <T extends object>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key) as T | undefined;
    if (hit) return hit;
    const value = await load();
    cache.set(key, value);
    return value;
  };

  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && opts.corsOrigins.includes(origin.toLowerCase())) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Run by infra/deploy.sh after each deploy. Pass/fail only, no business
  // numbers; unauthenticated, so results are reused for a minute to bound cost.
  let lastCheck: { at: number; result: Awaited<ReturnType<typeof runSelfCheck>> } | null = null;
  app.get("/healthz/deep", async (_req, res) => {
    if (!lastCheck || Date.now() - lastCheck.at > 60_000) {
      lastCheck = { at: Date.now(), result: await runSelfCheck(opts.warehouse, (start, end) => opts.warehouse.referenceTotals(start, end)) };
    }
    res.status(lastCheck.result.ok ? 200 : 500).json(lastCheck.result);
  });

  const api = express.Router();
  api.use(express.json({ limit: "256kb" }));
  api.use(requireViewer(opts.auth));
  api.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });

  api.get("/me", (req, res) => {
    const v = req.viewer!;
    const body: MeResponse = { email: v.email, name: v.name, isAdmin: v.isAdmin, adminsUnconfigured: v.adminsUnconfigured ?? false };
    res.json(body);
  });

  api.get("/me/preferences", async (req, res) => {
    res.json(await opts.preferences.get(req.viewer!.email));
  });

  api.put("/me/preferences", async (req, res) => {
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid preferences", issues: parsed.error.issues });
      return;
    }
    await opts.preferences.set(req.viewer!.email, parsed.data);
    res.json(parsed.data);
  });

  api.get("/freshness", async (_req, res) => {
    res.json({ sources: await opts.freshness.freshness() });
  });

  api.get("/revenue/summary", async (req, res) => {
    const raw = req.query;
    const parsed = revenueQuerySchema.safeParse({
      ...raw,
      businessLines: csv(raw.businessLines)?.filter(isBusinessLineOrUnassigned),
      sources: csv(raw.sources)?.filter(isSource),
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      return;
    }
    // "By season" uses the line's own seasons when the view is one business line; calendar years otherwise.
    const settings = await opts.seasons.get();
    const only = parsed.data.businessLines?.length === 1 ? parsed.data.businessLines[0]! : null;
    const seasons = only && isBusinessLine(only) ? lineCalendar(only, settings) : CALENDAR_YEAR;
    res.json(
      await cached(`revenue:${JSON.stringify(parsed.data)}:${JSON.stringify(settings)}`, () => opts.warehouse.revenueSummary(parsed.data, seasons)),
    );
  });

  api.get("/retail/:source/kpis", async (req, res) => {
    const source = String(req.params.source);
    if (!isRetailSource(source)) {
      res.status(404).json({ error: "Unknown retail platform" });
      return;
    }
    const parsed = retailKpiQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      return;
    }
    res.json(await cached(`kpis:${source}:${JSON.stringify(parsed.data)}`, () => opts.warehouse.retailKpis(source, parsed.data)));
  });

  api.get("/retail/:source/breakdown", async (req, res) => {
    const source = String(req.params.source);
    if (!isRetailSource(source)) {
      res.status(404).json({ error: "Unknown retail platform" });
      return;
    }
    const parsed = retailBreakdownQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      return;
    }
    res.json(await cached(`breakdown:${source}:${JSON.stringify(parsed.data)}`, () => opts.warehouse.retailBreakdown(source, parsed.data)));
  });

  api.get("/shopify/inventory", async (_req, res) => {
    res.json(await cached("inventory:shopify", () => opts.warehouse.shopifyInventory()));
  });

  // ---- Schools (Settings → Schools; used by reports and the Campminder breakdowns) ----
  // Rows stored before the import dropped non-school answers (emails…) are never shown.
  const schoolSpellings = () =>
    cached("schools", () => opts.warehouse.schoolList().then((rows) => ({ rows: rows.filter((s) => cleanSchool(s.entered) !== null) })));
  const schoolSettings = async () => readSchoolSettings(await opts.schools.get(), opts.officialSchools) ?? EMPTY_SCHOOL_SETTINGS;
  // Resolving takes a moment against the whole directory, so it's redone only when the spellings or settings change.
  let resolution: { key: string; value: SchoolResolution } | null = null;
  const schoolResolution = async () => {
    const [settings, spellings] = await Promise.all([schoolSettings(), schoolSpellings()]);
    const key = createHash("sha1").update(JSON.stringify(spellings.rows)).update(JSON.stringify(settings)).digest("hex").slice(0, 16);
    if (resolution?.key !== key) resolution = { key, value: resolveSchoolSpellings(spellings.rows, opts.officialSchools, settings) };
    return resolution;
  };
  /** Every school spelling's school for reports; `key` changes whenever any of them does. */
  const schoolMap = async () => {
    const r = await schoolResolution();
    return { map: r.value.bySpelling, key: r.key };
  };
  // Directory search for "choose a school": official schools and those added on Settings.
  let directory: { key: string; matcher: SchoolMatcher; info: Map<string, object> } | null = null;
  const schoolDirectory = async () => {
    const settings = await schoolSettings();
    const key = JSON.stringify(settings.schools);
    if (directory?.key !== key) {
      const all = [
        ...opts.officialSchools.map((o) => ({ id: o.id, name: o.name, level: o.level, city: o.city, state: o.state, type: o.type, aliases: o.formerNames })),
        ...Object.entries(settings.schools).map(([id, c]) => ({ id, name: c.name, level: "" as const, city: null, state: c.state, type: c.type, aliases: [] })),
        ...BUILTIN_SCHOOLS.map((b) => ({ id: b.id, name: b.name, level: "" as const, city: null, state: null, type: b.type, aliases: b.aliases })),
      ];
      directory = { key, matcher: new SchoolMatcher(all), info: new Map(all.map(({ aliases: _a, ...s }) => [s.id, s])) };
    }
    return directory;
  };

  const enrollmentRoute = <T extends { success: boolean }>(path: string, parse: (q: unknown) => T, run: (data: never) => Promise<object>) =>
    api.get(path, async (req, res) => {
      const parsed = parse(req.query) as unknown as { success: boolean; data?: unknown; error?: { issues: unknown } };
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query", issues: parsed.error?.issues });
        return;
      }
      const schoolsKey = path === "/campminder/seasons" ? "" : (await schoolMap()).key;
      res.json(await cached(`${path}:${JSON.stringify(parsed.data)}:${schoolsKey}`, () => run(parsed.data as never)));
    });

  enrollmentRoute("/campminder/seasons", (q) => enrollmentSeasonsQuerySchema.safeParse(q), (d: { businessLine?: BusinessLineOrUnassigned }) =>
    opts.warehouse.enrollmentSeasons(d.businessLine).then((seasons) => ({ seasons })),
  );
  enrollmentRoute("/campminder/summary", (q) => enrollmentSummaryQuerySchema.safeParse(q), async (d: EnrollmentSummaryQuery) => {
    const [s, schools] = await Promise.all([opts.seasons.get(), schoolMap()]);
    return opts.warehouse.enrollmentSummary(d, campminderCalendar(s.campminderStarts), schools.map);
  });
  enrollmentRoute("/campminder/map", (q) => enrollmentMapQuerySchema.safeParse(q), async (d: EnrollmentMapQuery) =>
    opts.warehouse.enrollmentMap(d, (await schoolMap()).map),
  );
  enrollmentRoute("/campminder/breakdown", (q) => enrollmentBreakdownQuerySchema.safeParse(q), async (d: EnrollmentBreakdownQuery) =>
    opts.warehouse.enrollmentBreakdown(d, (await schoolMap()).map),
  );

  // ---- Report builder ----

  api.post("/reports/run", async (req, res) => {
    const parsed = reportSpecSchema.safeParse(req.body?.spec);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; "), issues: parsed.error.issues });
      return;
    }
    const [families, schools] = await Promise.all([opts.programFamilies.get(), schoolMap()]);
    res.json(
      await cached(`report:${JSON.stringify(parsed.data)}:${JSON.stringify(families)}:${schools.key}`, () =>
        opts.warehouse.runReport(parsed.data, families, schools.map),
      ),
    );
  });

  // Values of one field under the report's other filters, for the filter picker.
  api.post("/reports/values", async (req, res) => {
    const parsed = reportValuesQuerySchema.safeParse(req.body);
    const info = parsed.success ? REPORT_DATASET_INFO[parsed.data.spec.dataset] : null;
    if (!parsed.success || !info!.fields.some((f) => f.id === parsed.data.field)) {
      res.status(400).json({ error: "Invalid field" });
      return;
    }
    const { spec, field } = parsed.data;
    const others = Object.fromEntries(Object.entries(spec.filters).filter(([k]) => k !== field));
    const otherExclusions = Object.fromEntries(Object.entries(spec.exclude).filter(([k]) => k !== field));
    const valuesSpec = {
      ...spec,
      rows: [field],
      column: undefined,
      filters: others,
      exclude: otherExclusions,
      measure: info!.defaultMeasure,
      percent: "none" as const,
      change: "none" as const,
    };
    const [families, schools] = await Promise.all([opts.programFamilies.get(), schoolMap()]);
    const result = await cached(`values:${JSON.stringify(valuesSpec)}:${JSON.stringify(families)}:${schools.key}`, () =>
      opts.warehouse.runReport(valuesSpec, families, schools.map),
    );
    res.json({
      field,
      values: result.cells.filter((c) => c.kind === "cell").map((c) => ({ value: c.rows[0]!, count: c.value ?? 0 })),
      truncated: result.truncated,
    });
  });

  const canEditReport = (r: SavedReport, viewer: { email: string; isAdmin: boolean }) =>
    !r.starter && (r.owner?.toLowerCase() === viewer.email.toLowerCase() || viewer.isAdmin);
  const visible = (r: SavedReport, email: string) => r.starter || r.shared || r.owner?.toLowerCase() === email.toLowerCase();

  api.get("/reports", async (req, res) => {
    const viewer = req.viewer!;
    const saved = (await opts.reports.list()).filter((r) => visible(r, viewer.email));
    res.json({
      reports: [...STARTER_REPORTS, ...saved.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))].map((r) => ({
        ...r,
        canEdit: canEditReport(r, viewer),
      })),
    });
  });

  api.get("/reports/:id", async (req, res) => {
    const viewer = req.viewer!;
    const r = STARTER_REPORTS.find((s) => s.id === req.params.id) ?? (await opts.reports.get(req.params.id));
    if (!r || !visible(r, viewer.email)) {
      res.status(404).json({ error: "Report not found" });
      return;
    }
    res.json({ ...r, canEdit: canEditReport(r, viewer) });
  });

  api.post("/reports", async (req, res) => {
    const parsed = savedReportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }
    const r = await opts.reports.create(parsed.data, req.viewer!.email);
    res.status(201).json({ ...r, canEdit: true });
  });

  api.put("/reports/:id", async (req, res) => {
    const existing = await opts.reports.get(req.params.id);
    if (!existing || !canEditReport(existing, req.viewer!)) {
      res.status(existing ? 403 : 404).json({ error: existing ? "Only the report's owner can change it" : "Report not found" });
      return;
    }
    const parsed = savedReportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }
    res.json({ ...(await opts.reports.update(req.params.id, parsed.data)), canEdit: true });
  });

  api.delete("/reports/:id", async (req, res) => {
    const existing = await opts.reports.get(req.params.id);
    if (!existing || !canEditReport(existing, req.viewer!)) {
      res.status(existing ? 403 : 404).json({ error: existing ? "Only the report's owner can delete it" : "Report not found" });
      return;
    }
    await opts.reports.delete(req.params.id);
    res.json({ ok: true });
  });

  api.get("/settings/program-families", async (_req, res) => {
    const [settings, programs] = await Promise.all([opts.programFamilies.get(), cached("programs", () => opts.warehouse.programList().then((rows) => ({ rows })))]);
    res.json({
      overrides: settings.overrides,
      programs: programs.rows.map((p) => {
        const o = settings.overrides[p.program];
        const d = draftProgramFamily(p.program);
        return { ...p, family: o?.family ?? d.family, branch: o ? o.branch : d.branch, origin: o ? "explicit" : "draft" };
      }),
    });
  });

  api.put("/settings/program-families", requireAdmin, async (req, res) => {
    const parsed = programFamilySettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid program families", issues: parsed.error.issues });
      return;
    }
    await opts.programFamilies.set(parsed.data, req.viewer!.email);
    cache.clear();
    res.json(parsed.data);
  });

  api.get("/settings/schools", async (_req, res) => {
    const r = (await schoolResolution()).value;
    res.json({ schools: r.schools, review: r.review, notSchools: r.notSchools, officialCount: opts.officialSchools.length });
  });

  api.get("/settings/schools/search", async (req, res) => {
    const q = String(req.query.q ?? "").slice(0, 120);
    const d = await schoolDirectory();
    res.json({ results: d.matcher.scores(q).slice(0, 15).map((m) => d.info.get(m.id)) });
  });

  api.post("/settings/schools/actions", requireAdmin, async (req, res) => {
    const parsed = schoolActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid change", issues: parsed.error.issues });
      return;
    }
    const a = parsed.data;
    const settings = await schoolSettings();
    const known = (id: string) => id in settings.schools || opts.officialSchools.some((o) => o.id === id) || BUILTIN_SCHOOLS.some((b) => b.id === id);
    const target = a.action === "assign" ? a.schoolId : a.action === "merge" ? a.into : null;
    if (target && !known(target)) {
      res.status(400).json({ error: "No such school" });
      return;
    }
    await opts.schools.set(applySchoolAction(settings, a), req.viewer!.email);
    cache.clear();
    res.json({ ok: true });
  });

  api.get("/settings/seasons", async (_req, res) => {
    res.json(await opts.seasons.get());
  });

  api.put("/settings/seasons", requireAdmin, async (req, res) => {
    const parsed = seasonSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid season settings", issues: parsed.error.issues });
      return;
    }
    await opts.seasons.set(parsed.data as SeasonSettings, req.viewer!.email);
    cache.clear();
    res.json(parsed.data);
  });

  api.get("/assignments", async (req, res) => {
    const { rows, pendingRefresh } = await opts.warehouse.assignments();
    const body: AssignmentsResponse = { rows, pendingRefresh, canEdit: req.viewer!.isAdmin };
    res.json(body);
  });

  api.put("/assignments", requireAdmin, async (req, res) => {
    const parsed = assignmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid assignments", issues: parsed.error.issues });
      return;
    }
    await opts.warehouse.saveAssignments(parsed.data.changes, req.viewer!.email);
    // Numbers change once the refresh finishes; don't serve stale cached ones after that.
    cache.clear();
    await opts.refresh.trigger().catch((err) => {
      console.error(JSON.stringify({ severity: "ERROR", message: "could not start refresh", error: String(err) }));
    });
    res.json({ ok: true, saved: parsed.data.changes.length });
  });

  app.use("/api", api);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(JSON.stringify({ severity: "ERROR", message: "request failed", error: String(err) }));
    res.status(500).json({ error: "Something went wrong loading this data" });
  });

  return app;
}
