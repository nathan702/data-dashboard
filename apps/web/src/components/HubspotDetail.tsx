import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { isYes, type BusinessLine, type HubspotProgramRow, type HubspotProgramsResponse, type HubspotProperty } from "@dash/shared";
import { useHubspotDeals, useHubspotPrograms } from "../lib/api";
import { formatDate, formatInt, formatPercent, formatUsd, formatUsdCompact, percentChange } from "../lib/format";

const CUR = "var(--series-1)";
const PREV = "var(--series-8)";

interface Totals {
  deals: number;
  revenue: number;
  participants: number;
  dealsWithParticipants: number;
  chaperones: number;
  dealsWithChaperones: number;
}
const zero = (): Totals => ({ deals: 0, revenue: 0, participants: 0, dealsWithParticipants: 0, chaperones: 0, dealsWithChaperones: 0 });
const add = (t: Totals, r: Totals) => {
  t.deals += r.deals;
  t.revenue += r.revenue;
  t.participants += r.participants;
  t.dealsWithParticipants += r.dealsWithParticipants;
  t.chaperones += r.chaperones;
  t.dealsWithChaperones += r.dealsWithChaperones;
  return t;
};
const sum = (rows: Totals[]) => rows.reduce((t, r) => add(t, r), zero());
const perPerson = (t: Totals) => (t.participants > 0 ? t.revenue / t.participants : 0);

/** This season (all won programs), last season at the same point, and last season in full. */
function split(rows: HubspotProgramRow[]) {
  return {
    cur: rows.filter((r) => r.period === "current"),
    sp: rows.filter((r) => r.period === "previous" && r.atSamePoint),
    full: rows.filter((r) => r.period === "previous"),
  };
}

const optionLabel = (p: HubspotProperty | null, v: string | null) => {
  if (v === null) return "(not set)";
  return p?.options.find((o) => o.value === v)?.label ?? v;
};

function Delta({ value, previous, money }: { value: number; previous: number; money?: boolean }) {
  const change = percentChange(value, previous);
  const dir = change === null || Math.abs(change) < 0.0005 ? "flat" : change > 0 ? "up" : "down";
  return (
    <div className={`tile-delta delta-${dir}`}>
      {dir !== "flat" && <span aria-hidden>{dir === "up" ? "▲ " : "▼ "}</span>}
      {formatPercent(change)} <span className="muted">vs {money ? formatUsdCompact(previous) : formatInt(previous)}</span>
    </div>
  );
}

function Tile({ label, value, previous, format, note }: { label: string; value: number; previous: number | null; format: (n: number) => string; note?: string }) {
  return (
    <div className="tile tile-small">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{format(value)}</div>
      {previous !== null && previous > 0 && <Delta value={value} previous={previous} money={format === formatUsdCompact || format === formatUsd} />}
      {note && <div className="muted" style={{ fontSize: 12 }}>{note}</div>}
    </div>
  );
}

const th = { padding: "8px 16px" };

/** Program type (or any choice property): programs, participants, revenue and spend per participant, against last season at the same point. */
function ByChoice({ rows, prop, pick, title }: { rows: HubspotProgramRow[]; prop: HubspotProperty | null; pick: (r: HubspotProgramRow) => string | null; title: string }) {
  const { cur, sp } = split(rows);
  const keys = [...new Set([...cur, ...sp].map(pick))];
  const data = keys
    .map((k) => ({ k, c: sum(cur.filter((r) => pick(r) === k)), p: sum(sp.filter((r) => pick(r) === k)) }))
    .sort((a, b) => b.c.revenue - a.c.revenue || b.p.revenue - a.p.revenue);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3 className="card-title">{title}</h3>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th style={th}>{prop?.label ?? title}</th>
              <th className="num" style={th}>Programs</th>
              <th className="num" style={th}>Participants</th>
              <th className="num" style={th}>Revenue</th>
              <th className="num" style={th}>Per participant</th>
              <th className="num" style={th}>Revenue last season</th>
              <th className="num" style={th}>Change</th>
            </tr>
          </thead>
          <tbody>
            {data.map(({ k, c, p }) => (
              <tr key={k ?? "(none)"}>
                <td>{optionLabel(prop, k)}</td>
                <td className="num">{formatInt(c.deals)}</td>
                <td className="num">{formatInt(c.participants)}</td>
                <td className="num">{formatUsd(c.revenue)}</td>
                <td className="num">{c.participants ? formatUsd(perPerson(c)) : "—"}</td>
                <td className="num muted">{formatUsd(p.revenue)}</td>
                <td className="num">{formatPercent(percentChange(c.revenue, p.revenue))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Share of programs using a service (food, transportation), this season vs last season at the same point. */
function Uptake({ rows, prop, pick, label }: { rows: HubspotProgramRow[]; prop: HubspotProperty | null; pick: (r: HubspotProgramRow) => string | null; label: string }) {
  const { cur, sp } = split(rows);
  const share = (list: HubspotProgramRow[]) => {
    const all = list.reduce((n, r) => n + r.deals, 0);
    const yes = list.filter((r) => isYes(pick(r)) || /^yes/i.test(optionLabel(prop, pick(r)))).reduce((n, r) => n + r.deals, 0);
    return { all, yes, share: all ? yes / all : 0 };
  };
  const c = share(cur);
  const p = share(sp);
  if (!prop) return null;
  return (
    <div className="tile tile-small">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{Math.round(c.share * 100)}%</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {formatInt(c.yes)} of {formatInt(c.all)} programs · last season {Math.round(p.share * 100)}%
      </div>
    </div>
  );
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function MonthChart({ rows, measure }: { rows: HubspotProgramRow[]; measure: "revenue" | "participants" | "deals" }) {
  const { cur, full } = split(rows);
  // Months in season order; last season's month lines up with the same month this season.
  const byMonth = new Map<string, { label: string; current: number; previous: number; order: string }>();
  const put = (r: HubspotProgramRow, key: "current" | "previous") => {
    const label = MONTH.format(new Date(`${r.month}T00:00:00Z`));
    const order = key === "current" ? r.month : `${Number(r.month.slice(0, 4)) + 1}${r.month.slice(4)}`;
    const e = byMonth.get(label) ?? { label, current: 0, previous: 0, order };
    if (order < e.order) e.order = order;
    e[key] += r[measure];
    byMonth.set(label, e);
  };
  cur.forEach((r) => put(r, "current"));
  full.forEach((r) => put(r, "previous"));
  const data = [...byMonth.values()].sort((a, b) => a.order.localeCompare(b.order));
  if (!data.length) return <div className="empty">No programs yet.</div>;
  const fmt = (v: number) => (measure === "revenue" ? formatUsdCompact(v) : formatInt(v));
  return (
    <div className="chart-plot" style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={1}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
          <YAxis tickFormatter={fmt} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={64} />
          <Tooltip formatter={(v) => fmt(Number(v))} />
          <Bar dataKey="previous" name="Last season" fill={PREV} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="current" name="This season" fill={CUR} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LineItems({ d }: { d: HubspotProgramsResponse }) {
  const cur = d.lineItems.filter((r) => r.period === "current");
  const sp = d.lineItems.filter((r) => r.period === "previous" && r.atSamePoint);
  const items = [...new Set([...cur, ...sp].map((r) => r.item))];
  const total = (list: typeof cur, item: string) =>
    list.filter((r) => r.item === item).reduce((t, r) => ({ quantity: t.quantity + r.quantity, amount: t.amount + r.amount, deals: t.deals + r.deals }), { quantity: 0, amount: 0, deals: 0 });
  const rows = items.map((item) => ({ item, c: total(cur, item), p: total(sp, item) })).sort((a, b) => b.c.amount - a.c.amount || b.p.amount - a.p.amount);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3 className="card-title">Line items</h3>
      </div>
      <p className="card-subtitle">Products on this season's won programs, against last season's at the same point.</p>
      {rows.length === 0 ? (
        <div className="empty">No line items yet. (The HubSpot key needs the line-items scope; see the setup notes.)</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={th}>Item</th>
                <th className="num" style={th}>Programs</th>
                <th className="num" style={th}>Quantity</th>
                <th className="num" style={th}>Amount</th>
                <th className="num" style={th}>Last season</th>
                <th className="num" style={th}>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, c, p }) => (
                <tr key={item}>
                  <td>{item}</td>
                  <td className="num">{formatInt(c.deals)}</td>
                  <td className="num">{formatInt(c.quantity)}</td>
                  <td className="num">{formatUsd(c.amount)}</td>
                  <td className="num muted">{formatUsd(p.amount)}</td>
                  <td className="num">{formatPercent(percentChange(c.amount, p.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OpenPipeline({ businessLine }: { businessLine: BusinessLine }) {
  const q = useHubspotDeals(businessLine);
  const open = q.data?.open ?? [];
  const total = open.reduce((t, r) => ({ deals: t.deals + r.deals, amount: t.amount + r.amount }), { deals: 0, amount: 0 });
  const pipelines = [...new Set(open.map((r) => r.pipeline))];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3 className="card-title">Open pipeline</h3>
        <span className="muted">
          {formatInt(total.deals)} deals · {formatUsd(total.amount)}
        </span>
      </div>
      {open.length === 0 ? (
        <div className="empty">No open deals.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {pipelines.length > 1 && <th style={th}>Pipeline</th>}
                <th style={th}>Stage</th>
                <th className="num" style={th}>Deals</th>
                <th className="num" style={th}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {open.map((r) => (
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
  );
}

/** Which season is shown: ?hss= in the URL, else the server's choice (the season under way). */
function useSeasonParam() {
  const [params, setParams] = useSearchParams();
  const season = Number(params.get("hss")) || undefined;
  const set = (s: number) => {
    const next = new URLSearchParams(params);
    next.set("hss", String(s));
    setParams(next, { replace: true });
  };
  return [season, set] as const;
}

/**
 * HubSpot programs for one business line: won deals by program date, this
 * season against last season at the same point (deals won by the same day a
 * year back) — programs, participants, chaperones, revenue and spend per
 * participant; by program type; food and transportation uptake; by month;
 * line items; and the open pipeline.
 */
export function HubspotDetail({ businessLine, title }: { businessLine: BusinessLine; title: string }) {
  const [season, setSeason] = useSeasonParam();
  const q = useHubspotPrograms(businessLine, season);
  const [measure, setMeasure] = useState<"revenue" | "participants" | "deals">("revenue");
  const d = q.data;
  const totals = useMemo(() => {
    if (!d) return null;
    const { cur, sp, full } = split(d.programs);
    return { cur: sum(cur), sp: sum(sp), full: sum(full) };
  }, [d]);

  const header = (
    <div className="card-header">
      <h2 className="section-title">{title}</h2>
      {d && d.seasons.length > 0 && (
        <label className="field field-inline">
          <span className="field-label">Season</span>
          <select value={d.season} onChange={(e) => setSeason(Number(e.target.value))}>
            {d.seasons.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
  if (q.error) {
    return (
      <section className="page-section" aria-label={title}>
        {header}
        <div className="error-banner">Couldn't load HubSpot programs: {q.error.message}</div>
      </section>
    );
  }
  if (!d || !totals) {
    return (
      <section className="page-section" aria-label={title}>
        {header}
        <div className="card empty">Loading…</div>
      </section>
    );
  }
  const { cur, sp, full } = totals;
  const roles = d.roles;
  const missing = (["participants", "chaperones", "programType", "food", "transportation"] as const).filter((r) => !roles[r]);
  return (
    <section className="page-section" aria-label={title}>
      {header}
      <p className="card-subtitle">
        Programs are won deals, by their program date ({formatDate(d.current.start)} – {formatDate(d.current.end)} this season). Last season "at the same point" =
        deals it had won by {formatDate(d.samePointCutoff)}.
        {missing.length > 0 && ` No HubSpot property found for: ${missing.join(", ")} (Settings → Seasons → HubSpot properties).`}
      </p>
      {d.seasons.length === 0 ? (
        <div className="card empty">No won HubSpot deals for this business line yet. Check Settings → Business lines → HubSpot pipelines.</div>
      ) : (
        <>
          <div className="tiles">
            <Tile label="Programs" value={cur.deals} previous={sp.deals} format={formatInt} note={`${formatInt(full.deals)} last season in all`} />
            <Tile label="Participants" value={cur.participants} previous={sp.participants} format={formatInt} />
            <Tile label="Chaperones" value={cur.chaperones} previous={sp.chaperones} format={formatInt} />
            <Tile label="Revenue" value={cur.revenue} previous={sp.revenue} format={formatUsdCompact} note={`${formatUsdCompact(full.revenue)} last season in all`} />
            <Tile
              label="Spend per participant"
              value={perPerson(cur)}
              previous={perPerson(sp) || null}
              format={formatUsd}
              note={cur.dealsWithParticipants < cur.deals ? `${cur.dealsWithParticipants} of ${cur.deals} programs have a participant count` : undefined}
            />
            <Uptake rows={d.programs} prop={roles.food} pick={(r) => r.food} label="Using our food" />
            <Uptake rows={d.programs} prop={roles.transportation} pick={(r) => r.transportation} label="Using our transportation" />
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header">
              <h3 className="card-title">By program month</h3>
              <label className="field field-inline">
                <span className="field-label">Show</span>
                <select value={measure} onChange={(e) => setMeasure(e.target.value as typeof measure)}>
                  <option value="revenue">Revenue</option>
                  <option value="participants">Participants</option>
                  <option value="deals">Programs</option>
                </select>
              </label>
            </div>
            <p className="card-subtitle">This season (programs won so far, including upcoming ones) against last season's final numbers.</p>
            <MonthChart rows={d.programs} measure={measure} />
          </div>

          {roles.programType && <ByChoice rows={d.programs} prop={roles.programType} pick={(r) => r.programType} title="By program type" />}
          {roles.food && <ByChoice rows={d.programs} prop={roles.food} pick={(r) => r.food} title="By food" />}
          {roles.transportation && <ByChoice rows={d.programs} prop={roles.transportation} pick={(r) => r.transportation} title="By transportation" />}
          <LineItems d={d} />
        </>
      )}
      <OpenPipeline businessLine={businessLine} />
    </section>
  );
}
