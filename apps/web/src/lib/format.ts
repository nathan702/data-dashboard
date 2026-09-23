const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const int = new Intl.NumberFormat("en-US");

export const formatUsd = (n: number) => usd.format(n);
export const formatUsdCompact = (n: number) => (Math.abs(n) < 10_000 ? usd.format(n) : usdCompact.format(n));
export const formatInt = (n: number) => int.format(n);

export function percentChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export function formatPercent(p: number | null): string {
  if (p === null) return "–";
  const sign = p > 0 ? "+" : p < 0 ? "−" : "";
  return `${sign}${Math.abs(p * 100).toFixed(1)}%`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(`${iso}T00:00:00Z`));
}

export function formatPeriod(iso: string, granularity: string): string {
  if (granularity === "month") return monthFmt.format(new Date(`${iso}T00:00:00Z`));
  if (granularity === "season") return `Season ${Number(iso.slice(0, 4)) + 1}`;
  if (granularity === "week") return `Wk of ${dateFmt.format(new Date(`${iso}T00:00:00Z`)).replace(/, \d{4}$/, "")}`;
  return formatDate(iso);
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
