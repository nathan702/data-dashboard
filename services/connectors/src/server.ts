import { createApp, type Role } from "./app.js";
import { createDeps } from "./deps.js";
import { loadConnectors } from "./sources/index.js";
import { logger } from "./core/logger.js";

const role = (process.env.SERVICE_ROLE ?? "all") as Role;
if (!["jobs", "webhooks", "all"].includes(role)) throw new Error(`Invalid SERVICE_ROLE: ${role}`);

const deps = createDeps({ dryRun: process.env.DRY_RUN === "1" });
const connectors = loadConnectors();
const app = createApp({ role, deps, connectors, publicBaseUrl: process.env.PUBLIC_BASE_URL });

// Empty raw tables for sources not connected yet, so the SQL transforms that read them run.
// Done before listening: Cloud Run starts an instance on deploy, before the deploy runs the transforms.
if (role !== "webhooks") {
  await Promise.all(
    [...connectors.values()].map(async (c) => {
      if (!c.rawEntities?.length || !deps.writer.ensureTables) return;
      await deps.writer.ensureTables(c.source, c.rawEntities).catch((err) => logger.error("could not create raw tables", { source: c.source, error: String(err) }));
    }),
  );
}

const port = Number(process.env.PORT ?? 8081);
app.listen(port, () => logger.info("connectors listening", { port, role }));
