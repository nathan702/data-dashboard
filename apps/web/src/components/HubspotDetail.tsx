import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BusinessLine } from "@dash/shared";
import { useHubspotDeals } from "../lib/api";
import { formatInt, formatUsd, formatUsdCompact } from "../lib/format";

const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

/** HubSpot deals for one business line: the open pipeline by stage, and won deals by month. */
export function HubspotDetail({ businessLine, title }: { businessLine: BusinessLine; title: string }) {
  const q = useHubspotDeals(businessLine);
  const d = q.data;
  const openTotal = (d?.open ?? []).reduce((t, r) => ({ deals: t.deals + r.deals, amount: t.amount + r.amount }), { deals: 0, amount: 0 });
  const pipelines = [...new Set((d?.open ?? []).map((r) => r.pipeline))];
  const won = (d?.won ?? []).map((r) => ({ ...r, label: monthLabel.format(new Date(`${r.month}T00:00:00Z`)) }));
  return (
    <section className="page-section" aria-label={title}>
      <div className="card-header">
        <h2 className="section-title">{title}</h2>
      </div>
      {q.error && <div className="error-banner">Couldn't load HubSpot deals: {q.error.message}</div>}
      {!d && !q.error && <div className="card empty">Loading…</div>}
      {d && d.open.length === 0 && d.won.length === 0 && (
        <div className="card empty">
          No HubSpot deals for this business line yet. Check Settings → Business lines → HubSpot pipelines, and that HubSpot is connected (Status page).
        </div>
      )}
      {d && (d.open.length > 0 || d.won.length > 0) && (
        <>
          <p className="card-subtitle">
            Won deals count as revenue on their close date (booked) and on the program date (service) where HubSpot has one. Open deals aren't revenue yet.
          </p>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Open pipeline</h3>
              <span className="muted">
                {formatInt(openTotal.deals)} deals · {formatUsd(openTotal.amount)}
              </span>
            </div>
            {d.open.length === 0 ? (
              <div className="empty">No open deals.</div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {pipelines.length > 1 && <th style={{ padding: "8px 16px" }}>Pipeline</th>}
                      <th style={{ padding: "8px 16px" }}>Stage</th>
                      <th className="num" style={{ padding: "8px 16px" }}>Deals</th>
                      <th className="num" style={{ padding: "8px 16px" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.open.map((r) => (
                      <tr key={`${r.pipeline}|${r.stage}`}>
                        {pipelines.length > 1 && <td>{r.pipeline}</td>}
                        <td>{r.stage}</td>
                        <td className="num">{formatInt(r.deals)}</td>
                        <td className="num">{formatUsd(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header">
              <h3 className="card-title">Won deals by month</h3>
            </div>
            <p className="card-subtitle">Amount of deals won, by the month they closed (last 24 months).</p>
            {won.length === 0 ? (
              <div className="empty">No won deals in the last 24 months.</div>
            ) : (
              <div className="chart-plot" style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={won} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid)" />
                    <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 11 }} interval={0} angle={-40} textAnchor="end" height={48} axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => formatUsdCompact(v)} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={64} />
                    <Tooltip
                      cursor={{ fill: "var(--grid)", opacity: 0.4 }}
                      content={({ active, payload }) => {
                        const p = payload?.[0]?.payload as (typeof won)[number] | undefined;
                        if (!active || !p) return null;
                        return (
                          <div className="chart-tooltip">
                            <div className="chart-tooltip-title">{p.label}</div>
                            <div className="chart-tooltip-row">
                              <strong>{formatUsd(p.amount)}</strong> <span className="muted">{formatInt(p.deals)} deals won</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="amount" fill="var(--series-3)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
