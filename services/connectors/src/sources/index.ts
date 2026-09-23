import type { BusinessLine } from "@dash/shared";
import type { Connector } from "../core/types.js";

/**
 * Connectors are added here as each phase lands (see docs/PLAN.md). A
 * factory returns null when the source's secrets aren't configured, so a
 * half-set-up environment still starts.
 */
export type ConnectorFactory = (env: NodeJS.ProcessEnv) => Connector | null;

export const CONNECTOR_FACTORIES: Partial<Record<BusinessLine, ConnectorFactory>> = {};

export function loadConnectors(env: NodeJS.ProcessEnv = process.env): Map<BusinessLine, Connector> {
  const out = new Map<BusinessLine, Connector>();
  for (const [source, factory] of Object.entries(CONNECTOR_FACTORIES) as Array<[BusinessLine, ConnectorFactory]>) {
    const c = factory(env);
    if (c) out.set(source, c);
  }
  return out;
}
