import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AssignmentsResponse,
  AssignmentUpdate,
  BusinessLineOrUnassigned,
  ComparisonMode,
  InventoryResponse,
  MeResponse,
  Preferences,
  RetailBreakdownResponse,
  RetailDimension,
  RetailKpiResponse,
  RetailSource,
  RevenueQuery,
  RevenueSummaryResponse,
  SourceFreshness,
} from "@dash/shared";
import { useAuth } from "./auth";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
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
    queryFn: async () => call<T>(path, await getToken()),
    enabled: status === "signed_in",
    // Keep showing the previous numbers while new ones load (no flashing).
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

function useApiMutation<TBody, TResult>(path: string, invalidate: unknown[][]) {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody) => call<TResult>(path, await getToken(), { method: "PUT", body }),
    onSuccess: () => Promise.all(invalidate.map((key) => qc.invalidateQueries({ queryKey: key }))),
  });
}

export function useMe() {
  return useApi<MeResponse>(["me"], "/api/me");
}

export function usePreferences() {
  return useApi<Preferences>(["preferences"], "/api/me/preferences");
}

export function useSavePreferences() {
  return useApiMutation<Preferences, Preferences>("/api/me/preferences", [["preferences"]]);
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
    groupBy: q.groupBy,
  });
  if (q.businessLines?.length) p.set("businessLines", q.businessLines.join(","));
  if (q.sources?.length) p.set("sources", q.sources.join(","));
  return p.toString();
}

export function useRevenueSummary(q: RevenueQuery) {
  const qs = revenueParams(q);
  // Re-poll every minute so "live" sources update without a reload.
  return useApi<RevenueSummaryResponse>(["revenue", qs], `/api/revenue/summary?${qs}`, { refetchInterval: 60_000 });
}

type RetailScope = { start: string; end: string; businessLine?: BusinessLineOrUnassigned };

function retailQs(q: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  return p.toString();
}

export function useRetailKpis(source: RetailSource, q: RetailScope & { compare: ComparisonMode }) {
  const qs = retailQs(q);
  return useApi<RetailKpiResponse>(["retail-kpis", source, qs], `/api/retail/${source}/kpis?${qs}`, { refetchInterval: 60_000 });
}

export function useRetailBreakdown(source: RetailSource, q: RetailScope & { dimension: RetailDimension }) {
  const qs = retailQs(q);
  return useApi<RetailBreakdownResponse>(["retail-breakdown", source, qs], `/api/retail/${source}/breakdown?${qs}`, {
    refetchInterval: 60_000,
  });
}

export function useShopifyInventory() {
  return useApi<InventoryResponse>(["shopify-inventory"], "/api/shopify/inventory", { refetchInterval: 5 * 60_000 });
}

export function useAssignments() {
  return useApi<AssignmentsResponse>(["assignments"], "/api/assignments", { refetchInterval: 60_000 });
}

export function useSaveAssignments() {
  return useApiMutation<AssignmentUpdate, { ok: true; saved: number }>("/api/assignments", [["assignments"], ["revenue"], ["retail-kpis"], ["retail-breakdown"]]);
}
