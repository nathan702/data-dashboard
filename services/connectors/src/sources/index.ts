import type { BusinessLine } from "@dash/shared";
import { EnvSecretStore, GcpSecretStore, type SecretStore } from "../core/secrets.js";
import type { Connector } from "../core/types.js";
import { ShopifyConnector, shopifyConfigFromEnv } from "./shopify.js";
import { SquareConnector, squareConfigFromEnv } from "./square.js";

/**
 * Connectors are added here as each phase lands (see docs/PLAN.md). They
 * read credentials at run time; a source without them reports "not
 * connected" instead of failing.
 */
export type ConnectorFactory = (env: NodeJS.ProcessEnv, secrets: SecretStore) => Connector | null;

export const CONNECTOR_FACTORIES: Partial<Record<BusinessLine, ConnectorFactory>> = {
  shopify: (env, secrets) => new ShopifyConnector(shopifyConfigFromEnv(env, secrets)),
  square: (env, secrets) => new SquareConnector(squareConfigFromEnv(env, secrets)),
};

export function defaultSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  return env.GCP_PROJECT_ID ? new GcpSecretStore(env.GCP_PROJECT_ID, env) : new EnvSecretStore(env);
}

export function loadConnectors(env: NodeJS.ProcessEnv = process.env, secrets = defaultSecretStore(env)): Map<BusinessLine, Connector> {
  const out = new Map<BusinessLine, Connector>();
  for (const [source, factory] of Object.entries(CONNECTOR_FACTORIES) as Array<[BusinessLine, ConnectorFactory]>) {
    const c = factory(env, secrets);
    if (c) out.set(source, c);
  }
  return out;
}
