import { GoogleAuth } from "google-auth-library";

/**
 * Slack direct messages through the Calleva Slack app (bot token with
 * chat:write and users:read.email). People are found by their sign-in email,
 * so nobody types a Slack ID.
 */
export type SendResult = "sent" | "no_slack_user" | "not_configured" | "failed";

export interface Messenger {
  /** Whether Slack is set up (the app's token is stored). */
  configured(): Promise<boolean>;
  slack(email: string, text: string): Promise<SendResult>;
}

export class SlackMessenger implements Messenger {
  private readonly ids = new Map<string, string | null>();
  constructor(
    private readonly token: () => Promise<string | null>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async configured() {
    return (await this.token()) !== null;
  }
  private async call(method: string, token: string, body: Record<string, string>, get = false): Promise<Record<string, unknown>> {
    const url = `https://slack.com/api/${method}${get ? `?${new URLSearchParams(body)}` : ""}`;
    const res = await this.fetchImpl(url, {
      method: get ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(get ? {} : { "Content-Type": "application/json; charset=utf-8" }) },
      body: get ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  async slack(email: string, text: string): Promise<SendResult> {
    const token = await this.token();
    if (!token) return "not_configured";
    try {
      let id = this.ids.get(email);
      if (id === undefined) {
        const r = await this.call("users.lookupByEmail", token, { email }, true);
        id = r.ok === true ? (((r.user as { id?: string } | undefined)?.id ?? null) as string | null) : null;
        if (r.ok !== true && r.error !== "users_not_found") throw new Error(`Slack users.lookupByEmail: ${String(r.error)}`);
        this.ids.set(email, id);
      }
      if (!id) return "no_slack_user";
      const r = await this.call("chat.postMessage", token, { channel: id, text, unfurl_links: "false" } as Record<string, string>);
      if (r.ok !== true) throw new Error(`Slack chat.postMessage: ${String(r.error)}`);
      return "sent";
    } catch (err) {
      console.error(JSON.stringify({ severity: "ERROR", message: "slack send failed", error: String(err) }));
      return "failed";
    }
  }
}

/** No Slack app yet: nothing is sent. */
export class NoMessenger implements Messenger {
  async configured() {
    return false;
  }
  async slack(): Promise<SendResult> {
    return "not_configured";
  }
}

/** Records what would be sent (tests and demo). */
export class MemoryMessenger implements Messenger {
  readonly sent: Array<{ email: string; text: string }> = [];
  constructor(private readonly slackUsers: string[] | "all" = "all") {}
  async configured() {
    return true;
  }
  async slack(email: string, text: string): Promise<SendResult> {
    if (this.slackUsers !== "all" && !this.slackUsers.includes(email)) return "no_slack_user";
    this.sent.push({ email, text });
    return "sent";
  }
}

export const SLACK_TOKEN_SECRET = "slack-bot-token";

/**
 * The Slack app's bot token: SLACK_BOT_TOKEN, else the slack-bot-token secret
 * in Secret Manager (read with the service's own account; cached 5 minutes).
 * Null until the app is installed and the token stored.
 */
export function slackTokenFromSecretManager(projectId: string | undefined, env: NodeJS.ProcessEnv = process.env): () => Promise<string | null> {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  let cache: { at: number; value: string | null } | null = null;
  return async () => {
    if (env.SLACK_BOT_TOKEN?.trim()) return env.SLACK_BOT_TOKEN.trim();
    if (!projectId) return null;
    if (cache && Date.now() - cache.at < 5 * 60_000) return cache.value;
    let value: string | null = null;
    try {
      const client = await auth.getClient();
      const res = await client.request<{ payload?: { data?: string } }>({
        url: `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${SLACK_TOKEN_SECRET}/versions/latest:access`,
      });
      const data = res.data.payload?.data;
      value = data ? Buffer.from(data, "base64").toString("utf8").trim() || null : null;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // No secret yet, or this account may not read it: Slack isn't set up.
      if (status !== 404 && status !== 403 && status !== 400) throw err;
    }
    cache = { at: Date.now(), value };
    return value;
  };
}
