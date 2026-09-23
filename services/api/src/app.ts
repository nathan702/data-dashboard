import express, { type NextFunction, type Request, type Response } from "express";
import { LRUCache } from "lru-cache";
import { isBusinessLine, revenueQuerySchema, type MeResponse } from "@dash/shared";
import { requireViewer, type AuthDeps } from "./auth.js";
import type { FreshnessSource, Warehouse } from "./warehouse/types.js";

export interface ApiOptions {
  /** null disables auth (local development only). */
  auth: AuthDeps | null;
  warehouse: Warehouse;
  freshness: FreshnessSource;
  corsOrigins: string[];
  cacheTtlSeconds: number;
}

export function createApi(opts: ApiOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // Short-lived cache: the same dashboard opened by several people only
  // queries BigQuery once per TTL, which keeps costs close to zero.
  const cache = new LRUCache<string, object>({ max: 500, ttl: opts.cacheTtlSeconds * 1000 });

  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && opts.corsOrigins.includes(origin.toLowerCase())) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
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
  api.use(requireViewer(opts.auth));
  api.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });

  api.get("/me", (req, res) => {
    const v = req.viewer!;
    const body: MeResponse = { email: v.email, name: v.name, isAdmin: v.isAdmin };
    res.json(body);
  });

  api.get("/freshness", async (_req, res) => {
    res.json({ sources: await opts.freshness.freshness() });
  });

  api.get("/revenue/summary", async (req, res) => {
    const raw = req.query;
    const lines = typeof raw.businessLines === "string" && raw.businessLines
      ? raw.businessLines.split(",").filter(isBusinessLine)
      : undefined;
    const parsed = revenueQuerySchema.safeParse({ ...raw, businessLines: lines });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      return;
    }
    const key = `revenue:${JSON.stringify(parsed.data)}`;
    let body = cache.get(key);
    if (!body) {
      body = await opts.warehouse.revenueSummary(parsed.data);
      cache.set(key, body);
    }
    res.json(body);
  });

  app.use("/api", api);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(JSON.stringify({ severity: "ERROR", message: "request failed", error: String(err) }));
    res.status(500).json({ error: "Something went wrong loading this data" });
  });

  return app;
}
