import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MeResponse, RevenueQuery, RevenueSummaryResponse, SourceFreshness } from "@dash/shared";
import { useAuth } from "./auth";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function useApi<T>(key: unknown[], path: string, opts: { refetchInterval?: number } = {}) {
  const { getToken, status } = useAuth();
  return useQuery({
    queryKey: key,
    queryFn: async () => getJson<T>(path, await getToken()),
    enabled: status === "signed_in",
    // Keep showing the previous numbers while new ones load (no flashing).
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

export function useMe() {
  return useApi<MeResponse>(["me"], "/api/me");
}

export function useFreshness() {
  return useApi<{ sources: SourceFreshness[] }>(["freshness"], "/api/freshness", { refetchInterval: 30_000 });
}

export function revenueParams(q: RevenueQuery): string {
  const p = new URLSearchParams({
    start: q.start,
    end: q.end,
    basis: q.basis,
    measure: q.measure,
    granularity: q.granularity,
    compare: q.compare,
  });
  if (q.businessLines?.length) p.set("businessLines", q.businessLines.join(","));
  return p.toString();
}

export function useRevenueSummary(q: RevenueQuery) {
  const qs = revenueParams(q);
  // Re-poll every minute so "live" sources update without a reload.
  return useApi<RevenueSummaryResponse>(["revenue", qs], `/api/revenue/summary?${qs}`, { refetchInterval: 60_000 });
}
