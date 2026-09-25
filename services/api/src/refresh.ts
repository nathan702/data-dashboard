import { GoogleAuth } from "google-auth-library";

/** Starts a data refresh (the SQL transform job) so saved Settings show up quickly. */
export interface RefreshTrigger {
  trigger(): Promise<void>;
}

/** Runs the Cloud Run transform job; repeated saves within two minutes share one run. */
export class CloudRunJobTrigger implements RefreshTrigger {
  private readonly auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  private lastRun = 0;

  constructor(
    /** projects/<project>/locations/<region>/jobs/<name> */
    private readonly job: string,
  ) {}

  async trigger() {
    if (Date.now() - this.lastRun < 2 * 60_000) return;
    this.lastRun = Date.now();
    const client = await this.auth.getClient();
    await client.request({ url: `https://run.googleapis.com/v2/${this.job}:run`, method: "POST", data: {} });
  }
}

export class NoopTrigger implements RefreshTrigger {
  triggered = 0;
  async trigger() {
    this.triggered++;
  }
}
