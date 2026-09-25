import type { ReactNode } from "react";
import type { BusinessLineOrUnassigned, RevenueGroup, RevenueMeasure, RevenueTotals, Source } from "@dash/shared";
import { useRevenueSummary } from "../lib/api";
import { ACCENT_VAR } from "../lib/colors";
import { useFilters } from "../lib/filters";
import { formatDate, formatInt, formatPercent, formatUsd, percentChange } from "../lib/format";
import { DataTable, type Column } from "./DataTable";
import { FilterBar } from "./FilterBar";
import { FreshnessNote } from "./Freshness";
import { RevenueChart, type SeriesDef } from "./RevenueChart";
import { StatTile } from "./StatTile";
import { TopBarChart } from "./TopBarChart";

export const pickMeasure = (t: RevenueTotals, m: RevenueMeasure) => (m === "gross" ? t.gross : m === "net" ? t.net : t.netAfterFees);

export interface GroupDef {
  key: string;
  label: string;
  /** Identity color, when groups are compared on one chart (platforms). */
  color?: string;
  /** Link for the group's own page. */
  href?: string;
}

interface Props {
  title: string;
  groupBy: "business_line" | "source";
  groups: GroupDef[];
  /** Extra filter: only these business lines / platforms count. */
  businessLines?: BusinessLineOrUnassigned[];
  sources?: Source[];
  /** Platforms whose freshness is shown under the title. */
  freshnessSources: Source[];
  /** Off where booked, paid and activity dates are the same (retail). */
  showBasis?: boolean;
  /** "total": one line for everything; "groups": a line per group (needs colors). */
  chart?: "total" | "groups";
  /** Horizontal bars ranking the groups. */
  rankGroups?: boolean;
  /** Table of every group's totals. */
  showTable?: boolean;
  /** Hide groups with nothing in this range or the comparison (e.g. "Unassigned"). */
  hideEmptyGroups?: string[];
  /**
   * Inside another view's page: no title bar, filters or total tile (the
   * outer view has them); uses the same URL filters.
   */
  embedded?: boolean;
  children?: ReactNode;
}

/** Filters, headline tiles, trend chart and tables for a set of groups. */
export function RevenueView({
  title,
  groupBy,
  groups,
  businessLines,
  sources,
  freshnessSources,
  showBasis = true,
  chart = "total",
  rankGroups = false,
  showTable = false,
  hideEmptyGroups = [],
  embedded = false,
  children,
}: Props) {
  const [filters, setFilters] = useFilters();
  const query = {
    start: filters.start,
    end: filters.end,
    basis: showBasis ? filters.basis : ("booked" as const),
    measure: filters.measure,
    granularity: filters.granularity,
    compare: filters.compare,
    groupBy,
    businessLines: businessLines ?? (groupBy === "business_line" ? (groups.map((g) => g.key) as BusinessLineOrUnassigned[]) : undefined),
    sources: sources ?? (groupBy === "source" ? (groups.map((g) => g.key) as Source[]) : undefined),
  };
  const { data, error, isFetching, isPlaceholderData } = useRevenueSummary(query);
  const m = filters.measure;

  const cmpLabel = data?.comparisonRange && filters.compare !== "none" ? (filters.compare === "previous_year" ? "last year" : "previous period") : null;
  const cmpLongLabel = filters.compare === "previous_year" ? "Same period last year" : "Previous period";

  const byKey = new Map((data?.groups ?? []).map((g) => [g.key, g]));
  const visible = groups.filter((g) => {
    if (!hideEmptyGroups.includes(g.key)) return true;
    const r = byKey.get(g.key);
    return r && (r.current.gross !== 0 || (r.comparison?.gross ?? 0) !== 0);
  });
  const total = visible.reduce((s, g) => s + (byKey.get(g.key) ? pickMeasure(byKey.get(g.key)!.current, m) : 0), 0);
  const totalPrev = data?.comparisonRange
    ? visible.reduce((s, g) => s + (byKey.get(g.key)?.comparison ? pickMeasure(byKey.get(g.key)!.comparison!, m) : 0), 0)
    : null;
  const single = visible.length === 1 ? visible[0]! : null;

  // Chart series: one total line (with comparison), or one line per group.
  const visibleKeys = new Set(visible.map((g) => g.key));
  const sumByPeriod = (pts: Array<{ period: string; key: string; value: number }>) => {
    const out = new Map<string, number>();
    for (const p of pts) if (visibleKeys.has(p.key)) out.set(p.period, (out.get(p.period) ?? 0) + p.value);
    return [...out.entries()].map(([period, value]) => ({ period, key: "total", value }));
  };
  const perGroup = chart === "groups" && visible.length > 1;
  const defs: SeriesDef[] = perGroup
    ? visible.map((g) => ({ key: g.key, label: g.label, color: g.color ?? ACCENT_VAR }))
    : [{ key: "total", label: single?.label ?? title, color: single?.color ?? ACCENT_VAR }];
  const points = data ? (perGroup ? data.series.filter((p) => visibleKeys.has(p.key)) : sumByPeriod(data.series)) : [];
  const comparison = data && cmpLabel && !perGroup ? { points: sumByPeriod(data.comparisonSeries), label: cmpLongLabel } : null;

  const labelOf = (key: string) => groups.find((g) => g.key === key)?.label ?? key;
  const columns: Column<RevenueGroup>[] = [
    { key: "group", label: groupBy === "source" ? "Platform" : "Business line", value: (r) => labelOf(r.key) },
    { key: "gross", label: "Gross", numeric: true, value: (r) => r.current.gross, render: (r) => formatUsd(r.current.gross) },
    { key: "discounts", label: "Discounts", numeric: true, value: (r) => r.current.discounts, render: (r) => formatUsd(r.current.discounts) },
    { key: "refunds", label: "Refunds", numeric: true, value: (r) => r.current.refunds, render: (r) => formatUsd(r.current.refunds) },
    { key: "net", label: "Net", numeric: true, value: (r) => r.current.net, render: (r) => formatUsd(r.current.net) },
    { key: "fees", label: "Fees", numeric: true, value: (r) => r.current.fees, render: (r) => formatUsd(r.current.fees) },
    { key: "netAfterFees", label: "Net after fees", numeric: true, value: (r) => r.current.netAfterFees, render: (r) => formatUsd(r.current.netAfterFees) },
    { key: "transactions", label: "Transactions", numeric: true, value: (r) => r.current.transactions, render: (r) => formatInt(r.current.transactions) },
  ];
  if (cmpLabel) {
    const prev = (r: RevenueGroup) => (r.comparison ? pickMeasure(r.comparison, m) : null);
    columns.push(
      { key: "prev", label: `${m === "gross" ? "Gross" : "Net"} ${cmpLabel}`, numeric: true, value: prev, render: (r) => (prev(r) === null ? "–" : formatUsd(prev(r)!)) },
      {
        key: "change",
        label: "Change",
        numeric: true,
        value: (r) => percentChange(pickMeasure(r.current, m), prev(r)),
        render: (r) => formatPercent(percentChange(pickMeasure(r.current, m), prev(r))),
      },
    );
  }

  const body = (
    <>
      {error && <div className="error-banner">Couldn't load revenue: {error.message}</div>}
      <div className={`page-body${isFetching && isPlaceholderData ? " refetching" : ""}`}>
        {data && (
          <>
            <section className="tiles" aria-label="Headline numbers">
              {!embedded && (
                <StatTile hero label={single ? single.label : "Total"} value={total} previous={totalPrev} comparisonLabel={cmpLabel} />
              )}
              {(!single || embedded) &&
                visible.map((g) => {
                  const r = byKey.get(g.key);
                  return (
                    <StatTile
                      key={g.key}
                      label={g.label}
                      href={g.href}
                      swatch={perGroup ? g.color : undefined}
                      value={r ? pickMeasure(r.current, m) : 0}
                      previous={r?.comparison ? pickMeasure(r.comparison, m) : null}
                      comparisonLabel={cmpLabel}
                    />
                  );
                })}
            </section>
            <section className="card">
              <h2 className="card-title">Revenue over time</h2>
              <p className="card-subtitle">
                {formatDate(data.range.start)} – {formatDate(data.range.end)}
                {data.comparisonRange && ` · compared with ${formatDate(data.comparisonRange.start)} – ${formatDate(data.comparisonRange.end)}`}
              </p>
              <RevenueChart defs={defs} points={points} granularity={filters.granularity} comparison={comparison} />
            </section>
            {rankGroups && visible.length > 1 && (
              <section className="card">
                <h2 className="card-title">{m === "gross" ? "Gross" : "Net"} sales by {groupBy === "source" ? "platform" : "business line"}</h2>
                <TopBarChart
                  rows={visible
                    .map((g) => ({ key: g.label, value: byKey.get(g.key) ? pickMeasure(byKey.get(g.key)!.current, m) : 0 }))
                    .sort((a, b) => b.value - a.value)}
                  color={ACCENT_VAR}
                  valueLabel={m === "gross" ? "gross sales" : "net sales"}
                />
              </section>
            )}
            {showTable && (
              <DataTable
                caption="Totals"
                rows={visible.map((g) => byKey.get(g.key)).filter((r): r is RevenueGroup => !!r)}
                columns={columns}
                rowKey={(r) => r.key}
                exportName={`revenue_${filters.start}_${filters.end}`}
              />
            )}
          </>
        )}
        {children}
      </div>
    </>
  );

  if (embedded) {
    return (
      <section className="page-section" aria-label={title}>
        <h2 className="section-title">{title}</h2>
        {body}
      </section>
    );
  }
  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <FreshnessNote sources={freshnessSources} />
      </header>
      <FilterBar filters={filters} onChange={setFilters} showBasis={showBasis} />
      {body}
    </div>
  );
}
