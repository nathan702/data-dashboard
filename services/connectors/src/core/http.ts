/**
 * fetch with timeouts and retries for rate limits (429) and transient
 * server errors, honoring Retry-After. Platform APIs throttle bursts
 * (especially during a full-history import), so this is the normal path.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}${new URL(url).pathname}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  // Exponential backoff with jitter: ~0.5s, 1s, 2s, 4s, ... capped at 30s.
  return Math.min(500 * 2 ** attempt, 30_000) * (0.75 + Math.random() * 0.5);
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 6;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: {
          Accept: "application/json",
          ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      // Network error or timeout.
      if (attempt >= maxRetries) throw err;
      await sleep(retryDelayMs(attempt, null));
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const body = await res.text();
    if (!RETRYABLE.has(res.status) || attempt >= maxRetries) throw new HttpError(res.status, body, url);
    await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
  }
}
