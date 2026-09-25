export interface ApiConfig {
  /** Google Workspace domains allowed to sign in, e.g. ["calleva.org"]. */
  allowedDomains: string[];
  /** Serve generated demo data instead of querying BigQuery. */
  demoData: boolean;
  /** Skip sign-in checks. Local development only; refused on Cloud Run. */
  authDisabled: boolean;
  martsDataset: string;
  configDataset: string;
  bqLocation: string;
  /** Cloud Run job that rebuilds the marts; started after Settings changes. */
  transformJob: string | undefined;
  projectId: string | undefined;
  /** Origins allowed to call the API from a browser (the Firebase Hosting URLs). */
  corsOrigins: string[];
  cacheTtlSeconds: number;
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const onCloudRun = Boolean(env.K_SERVICE);
  const authDisabled = env.AUTH_DISABLED === "1";
  if (authDisabled && onCloudRun) throw new Error("AUTH_DISABLED is not allowed on Cloud Run");
  const allowedDomains = list(env.ALLOWED_DOMAINS);
  if (!authDisabled && allowedDomains.length === 0) throw new Error("ALLOWED_DOMAINS must be set");
  return {
    allowedDomains,
    demoData: env.DEMO_DATA === "1",
    authDisabled,
    martsDataset: env.BQ_MARTS_DATASET ?? "marts",
    configDataset: env.BQ_CONFIG_DATASET ?? "config",
    bqLocation: env.BQ_LOCATION ?? "US",
    transformJob: env.TRANSFORM_JOB,
    projectId: env.GCP_PROJECT_ID,
    corsOrigins: list(env.CORS_ORIGINS),
    cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 60),
  };
}
