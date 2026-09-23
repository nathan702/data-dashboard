import { BUSINESS_LINE_INFO, type BusinessLine, type RevenueByLine, type RevenueMeasure, type RevenueTotals } from "@dash/shared";
import { useRevenueSummary } from "../lib/api";
import { LINE_COLOR_VAR } from "../lib/colors";
import { useFilters } from "../lib/filters";
import { formatDate, formatInt, formatPercent, formatUsd, percentChange } from "../lib/format";
import { DataTable, type Column } from "./DataTable";
import { FilterBar } from "./FilterBar";
import { FreshnessNote } from "./Freshness";
import { RevenueChart } from "./RevenueChart";
import { StatTile } from "./StatTile";

const pickMeasure = (t: RevenueTotals, m: RevenueMeasure) => (m === "gross" ? t.gross : m === "net" ? t.net : t.netAfterFees);

/** Filters, headline tiles, trend chart and table for one or more business lines. */
export function RevenueView({ lines, title }: { lines: BusinessLine[]; title: string }) {
  const [filters, setFilters] = useFilters();
  const query = {
    start: filters.start,
    end: filters.end,
    basis: filters.basis,
    measure: filters.measure,
    granularity: filters.granularity,
    compare: filters.compare,
    businessLines: lines,
  };
  const { data, error, isFetching, isPlaceholderData } = useRevenueSummary(query);

  const cmpLabel =
    data?.comparisonRange && filters.compare !== "none"
      ? filters.compare === "previous_year"
        ? "last year"
        : "previous period"
      : null;
  const total = (data?.byLine ?? []).reduce((s, b) => s + pickMeasure(b.current, filters.measure), 0);
  const totalPrev = data?.comparisonRange
    ? (data?.byLine ?? []).reduce((s, b) => s + (b.comparison ? pickMeasure(b.comparison, filters.measure) : 0), 0)
    : null;

  const columns: Column<RevenueByLine>[] = [
    {
      key: "line",
      label: "Business line",
      value: (r) => BUSINESS_LINE_INFO[r.businessLine].label,
      render: (r) => (
        <span className="cell-line">
          <span className="swatch" style={{ background: LINE_COLOR_VAR[r.businessLine] }} aria-hidden />
          {BUSINESS_LINE_INFO[r.businessLine].label}
        </span>
      ),
    },
    { key: "gross", label: "Gross", numeric: true, value: (r) => r.current.gross, render: (r) => formatUsd(r.current.gross) },
    { key: "discounts", label: "Discounts", numeric: true, value: (r) => r.current.discounts, render: (r) => formatUsd(r.current.discounts) },
    { key: "refunds", label: "Refunds", numeric: true, value: (r) => r.current.refunds, render: (r) => formatUsd(r.current.refunds) },
    { key: "net", label: "Net", numeric: true, value: (r) => r.current.net, render: (r) => formatUsd(r.current.net) },
    { key: "fees", label: "Fees", numeric: true, value: (r) => r.current.fees, render: (r) => formatUsd(r.current.fees) },
    { key: "netAfterFees", label: "Net after fees", numeric: true, value: (r) => r.current.netAfterFees, render: (r) => formatUsd(r.current.netAfterFees) },
    { key: "transactions", label: "Transactions", numeric: true, value: (r) => r.current.transactions, render: (r) => formatInt(r.current.transactions) },
  ];
  if (cmpLabel) {
    columns.push(
      {
        key: "prev",
        label: `${filters.measure === "gross" ? "Gross" : "Net"} ${cmpLabel}`,
        numeric: true,
        value: (r) => (r.comparison ? pickMeasure(r.comparison, filters.measure) : null),
        render: (r) => (r.comparison ? formatUsd(pickMeasure(r.comparison, filters.measure)) : "–"),
      },
      {
        key: "change",
        label: "Change",
        numeric: true,
        value: (r) => percentChange(pickMeasure(r.current, filters.measure), r.comparison ? pickMeasure(r.comparison, filters.measure) : null),
        render: (r) =>
          formatPercent(percentChange(pickMeasure(r.current, filters.measure), r.comparison ? pickMeasure(r.comparison, filters.measure) : null)),
      },
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <FreshnessNote sources={lines} />
      </header>
      <FilterBar filters={filters} onChange={setFilters} />
      {error && <div className="error-banner">Couldn't load revenue: {error.message}</div>}
      <div className={`page-body${isFetching && isPlaceholderData ? " refetching" : ""}`}>
        {data && (
          <>
            <section className="tiles" aria-label="Headline numbers">
              {lines.length > 1 && (
                <StatTile hero label="All business lines" value={total} previous={totalPrev} comparisonLabel={cmpLabel} />
              )}
              {data.byLine.map((b) => (
                <StatTile
                  key={b.businessLine}
                  hero={lines.length === 1}
                  label={BUSINESS_LINE_INFO[b.businessLine].label}
                  swatch={lines.length > 1 ? LINE_COLOR_VAR[b.businessLine] : undefined}
                  value={pickMeasure(b.current, filters.measure)}
                  previous={b.comparison ? pickMeasure(b.comparison, filters.measure) : null}
                  comparisonLabel={cmpLabel}
                />
              ))}
            </section>
            <section className="card">
              <h2 className="card-title">Revenue over time</h2>
              <p className="card-subtitle">
                {formatDate(data.range.start)} – {formatDate(data.range.end)}
                {data.comparisonRange && ` · compared with ${formatDate(data.comparisonRange.start)} – ${formatDate(data.comparisonRange.end)}`}
              </p>
              <RevenueChart series={data.series} lines={lines} granularity={filters.granularity} />
            </section>
            <DataTable
              caption="Breakdown"
              rows={data.byLine}
              columns={columns}
              rowKey={(r) => r.businessLine}
              exportName={`revenue_${filters.start}_${filters.end}`}
              searchable={lines.length > 1}
            />
          </>
        )}
      </div>
    </div>
  );
}
