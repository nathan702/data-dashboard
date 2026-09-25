import express, { type NextFunction, type Request, type Response } from "express";
import { LRUCache } from "lru-cache";
import {
  assignmentUpdateSchema,
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
import type { PreferencesStore } from "./preferences.js";
import type { RefreshTrigger } from "./refresh.js";
import type { FreshnessSource, Warehouse } from "./warehouse/types.js";

export interface ApiOptions {
  /** null disables auth (local development only). */
  auth: AuthDeps | null;
  warehouse: Warehouse;
  freshness: FreshnessSource;
  preferences: PreferencesStore;
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
    res.json(await cached(`revenue:${JSON.stringify(parsed.data)}`, () => opts.warehouse.revenueSummary(parsed.data)));
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
