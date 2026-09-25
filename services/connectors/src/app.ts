import express, { type Request, type Response } from "express";
import { isSource, type Source } from "@dash/shared";
import { handleWebhook, runSync, type Deps } from "./core/runner.js";
import { WebhookAuthError, type Connector } from "./core/types.js";
import { logger } from "./core/logger.js";

/**
 * The same image is deployed twice:
 * - role "jobs": private Cloud Run service (IAM-only), called by Cloud Scheduler
 * - role "webhooks": public service; every request is signature-verified
 * Keeping them separate means the scheduled-sync endpoints are never public.
 */
export type Role = "jobs" | "webhooks" | "all";

export interface AppOptions {
  role: Role;
  deps: Deps;
  connectors: Map<Source, Connector>;
  /** Public base URL of the webhooks service, used when signatures cover the URL. */
  publicBaseUrl?: string;
}

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

export function createApp({ role, deps, connectors, publicBaseUrl }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, role, connectors: [...connectors.keys()] });
  });

  const lookup = (req: Request, res: Response): Connector | null => {
    const source = String(req.params.source);
    if (!isSource(source)) {
      res.status(404).json({ error: "Unknown source" });
      return null;
    }
    const c = connectors.get(source);
    if (!c) {
      res.status(404).json({ error: `${source} is not configured` });
      return null;
    }
    return c;
  };

  if (role === "jobs" || role === "all") {
    app.post("/run/:source", async (req, res) => {
      const connector = lookup(req, res);
      if (!connector) return;
      if (!connector.sync) {
        res.status(400).json({ error: "This source does not support scheduled sync" });
        return;
      }
      const mode = req.query.mode === "backfill" ? "backfill" : "incremental";
      const result = await runSync(connector, deps, mode);
      // 500 lets Cloud Scheduler record the failure and retry.
      res.status(result.status === "ok" ? 200 : 500).json(result);
    });
  }

  if (role === "webhooks" || role === "all") {
    app.post(
      "/webhooks/:source",
      express.raw({ type: () => true, limit: MAX_WEBHOOK_BYTES }),
      async (req, res) => {
        const connector = lookup(req, res);
        if (!connector) return;
        if (!connector.handleWebhook) {
          res.status(404).json({ error: "This source does not accept webhooks" });
          return;
        }
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : v;
        const base = publicBaseUrl ?? `${req.protocol}://${req.get("host")}`;
        try {
          const n = await handleWebhook(connector, deps, {
            headers,
            rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            url: `${base}${req.originalUrl}`,
          });
          res.status(200).json({ ok: true, stored: n });
        } catch (err) {
          if (err instanceof WebhookAuthError) {
            logger.warn("rejected webhook", { source: connector.source, reason: err.message });
            res.status(401).json({ error: "Invalid signature" });
            return;
          }
          logger.error("webhook failed", { source: connector.source, error: String(err) });
          // 500 makes the platform retry delivery later.
          res.status(500).json({ error: "Failed to store webhook" });
        }
      },
    );
  }

  return app;
}
