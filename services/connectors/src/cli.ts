/**
 * Run a sync from a terminal:
 *   npm run sync -w services/connectors -- shopify            # incremental
 *   npm run sync -w services/connectors -- shopify --backfill # all history
 *   npm run sync -w services/connectors -- shopify --dry-run  # don't write to GCP
 */
import { isSource } from "@dash/shared";
import { createDeps } from "./deps.js";
import { runSync } from "./core/runner.js";
import { loadConnectors } from "./sources/index.js";
import type { MemoryRawWriter } from "./core/memory.js";

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
if (!source || !isSource(source)) {
  console.error("Usage: sync <campminder|fareharbor|hubspot|shopify|square> [--backfill] [--dry-run]");
  process.exit(2);
}
const connector = loadConnectors().get(source);
if (!connector) {
  console.error(`${source} is not configured (missing connector or secrets)`);
  process.exit(2);
}
const dryRun = args.includes("--dry-run");
const deps = createDeps({ dryRun });
const result = await runSync(connector, deps, args.includes("--backfill") ? "backfill" : "incremental");
if (dryRun) console.log(`dry run: ${(deps.writer as MemoryRawWriter).rows.length} records would be written`);
process.exit(result.status === "ok" ? 0 : 1);
