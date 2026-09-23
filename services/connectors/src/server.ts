import { createApp, type Role } from "./app.js";
import { createDeps } from "./deps.js";
import { loadConnectors } from "./sources/index.js";
import { logger } from "./core/logger.js";

const role = (process.env.SERVICE_ROLE ?? "all") as Role;
if (!["jobs", "webhooks", "all"].includes(role)) throw new Error(`Invalid SERVICE_ROLE: ${role}`);

const app = createApp({
  role,
  deps: createDeps({ dryRun: process.env.DRY_RUN === "1" }),
  connectors: loadConnectors(),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
});

const port = Number(process.env.PORT ?? 8081);
app.listen(port, () => logger.info("connectors listening", { port, role }));
