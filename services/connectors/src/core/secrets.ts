import { GoogleAuth } from "google-auth-library";

/**
 * Connector credentials live in Secret Manager and are read at run time, so
 * adding or rotating a key never needs a redeploy. A same-named environment
 * variable (shopify-client-id → SHOPIFY_CLIENT_ID) overrides it, which is
 * how local development and tests supply values.
 */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  add(name: string, value: string): Promise<void>;
}

export const envName = (secret: string) => secret.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(name: string) {
    return this.env[envName(name)]?.trim() || undefined;
  }
  async add(name: string, value: string) {
    this.env[envName(name)] = value;
  }
}

const CACHE_MS = 5 * 60_000;

export class GcpSecretStore implements SecretStore {
  private readonly auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  private readonly cache = new Map<string, { at: number; value: string | undefined }>();

  constructor(
    private readonly projectId: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async get(name: string): Promise<string | undefined> {
    const override = this.env[envName(name)]?.trim();
    if (override) return override;
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const client = await this.auth.getClient();
    let value: string | undefined;
    try {
      const res = await client.request<{ payload?: { data?: string } }>({
        url: `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets/${name}/versions/latest:access`,
      });
      const data = res.data.payload?.data;
      value = data ? Buffer.from(data, "base64").toString("utf8").trim() || undefined : undefined;
    } catch (err) {
      // No version yet (or no secret) means "not configured", not a crash.
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== 404 && status !== 400 && status !== 403) throw err;
      value = undefined;
    }
    this.cache.set(name, { at: Date.now(), value });
    return value;
  }

  async add(name: string, value: string): Promise<void> {
    const client = await this.auth.getClient();
    await client.request({
      url: `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets/${name}:addVersion`,
      method: "POST",
      data: { payload: { data: Buffer.from(value, "utf8").toString("base64") } },
    });
    this.cache.set(name, { at: Date.now(), value });
  }
}

/** Thrown when a source's credentials haven't been added yet. Not a failure. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export async function requireSecret(store: SecretStore, name: string, source: string): Promise<string> {
  const v = await store.get(name);
  if (!v) throw new NotConfiguredError(`${source} isn't connected yet: add the "${name}" secret`);
  return v;
}
