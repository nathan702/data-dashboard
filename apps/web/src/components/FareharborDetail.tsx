import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  LEAD_BUCKET_LABEL,
  LEAD_GROUPS,
  perGuest,
  summarizeFareharbor,
  ticketTypeFor,
  TICKET_TYPE_LABEL,
  TICKET_TYPES,
  type TicketType,
  type BusinessLine,
  type FareharborSummary,
  type Metrics,
  type WeekendLead,
} from "@dash/shared";
import { useFareharborDays, useMe, useSaveSeasonSettings, useSeasonSettings } from "../lib/api";
import { formatDate, formatInt, formatPercent, formatUsd, formatUsdCompact, percentChange } from "../lib/format";

const CUR = "var(--series-1)";
const PREV = "var(--series-8)";
const LEAD_COLORS = ["var(--series-8)", "var(--series-2)", "var(--series-4)", "var(--series-3)", "var(--series-1)", "var(--series-7)"];

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

function Tile({ label, value, previous, money, note }: { label: string; value: number; previous: number | null; money?: boolean; note?: string }) {
  return (
    <div className="tile tile-small">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{money ? formatUsdCompact(value) : formatInt(value)}</div>
      {previous !== null && previous > 0 && <Delta value={value} previous={previous} money={money} />}
      {note && <div className="muted" style={{ fontSize: 12 }}>{note}</div>}
    </div>
  );
}

const nightsWord = (nightly: boolean, n: number) => (nightly ? (n === 1 ? "night" : "nights") : n === 1 ? "week" : "weeks");

/** Totals table: one row per comparison, revenue, guests, per guest, then guests by group. */
function TotalsTable({ s, rows, nightly }: { s: FareharborSummary; rows: Array<{ label: string; days: number; m: Metrics; emphasis?: boolean }>; nightly: boolean }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th style={{ padding: "8px 16px" }} />
            <th className="num" style={{ padding: "8px 16px" }}>Revenue</th>
            <th className="num" style={{ padding: "8px 16px" }}>Guests</th>
            <th className="num" style={{ padding: "8px 16px" }}>Per guest</th>
            {s.groups.map((g) => (
              <th key={g} className="num" style={{ padding: "8px 16px" }}>
                {s.groupLabel(g)} guests
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} style={r.emphasis ? { fontWeight: 600 } : undefined}>
              <td>
                {r.label} <span className="muted">({r.days} {nightsWord(nightly, r.days)})</span>
              </td>
              <td className="num">{formatUsd(r.m.revenue)}</td>
              <td className="num">{formatInt(r.m.guests)}</td>
              <td className="num">{formatUsd(perGuest(r.m))}</td>
              {s.groups.map((g) => (
                <td key={g} className="num">
                  {formatInt(r.m.byGroup[g]?.guests ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayChart({ s, measure, held }: { s: FareharborSummary; measure: "revenue" | "guests"; held: boolean }) {
  const data = s.days
    .filter((d) => d.held === held)
    .map((d) => ({
      label: d.label,
      date: d.day ?? d.aligned,
      closed: d.day !== null && d.current === null,
      current: d.current?.[measure] ?? 0,
      previous: (held ? d.previous : d.previousAtSamePoint)?.[measure] ?? 0,
    }));
  if (data.length === 0) return <div className="empty">{held ? "No days held yet this season." : "No upcoming days with sales."}</div>;
  const fmt = (v: number) => (measure === "revenue" ? formatUsdCompact(v) : formatInt(v));
  return (
    <div className="chart-plot" style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={1}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 11 }} interval={0} angle={data.length > 12 ? -40 : 0} textAnchor={data.length > 12 ? "end" : "middle"} height={data.length > 12 ? 56 : 30} axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
          <YAxis tickFormatter={fmt} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={64} />
          <Tooltip
            cursor={{ fill: "var(--grid)", opacity: 0.4 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!active || !p) return null;
              return (
                <div className="chart-tooltip">
                  <div className="chart-tooltip-title">
                    {p.label} · {formatDate(p.date)}
                    {p.closed ? " (closed)" : ""}
                  </div>
                  <div className="chart-tooltip-row">
                    <span className="line-key" style={{ background: CUR }} aria-hidden />
                    <strong>{fmt(p.current)}</strong> <span className="muted">this season{held ? "" : " so far"}</span>
                  </div>
                  <div className="chart-tooltip-row">
                    <span className="line-key" style={{ background: PREV }} aria-hidden />
                    <strong>{fmt(p.previous)}</strong> <span className="muted">last season{held ? "" : " at the same point"}</span>
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey="previous" name={held ? "Last season" : "Last season at the same point"} fill={PREV} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="current" name={held ? "This season" : "This season so far"} fill={CUR} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** "10/2" */
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

const shares = (arr: number[]) => {
  const total = arr.reduce((a, b) => a + b, 0);
  return arr.map((n) => (total > 0 ? n / total : 0));
};

function LeadChart({ s }: { s: FareharborSummary }) {
  const cur = shares(s.lead.current);
  const sp = shares(s.lead.previousAtSamePoint);
  const full = shares(s.lead.previousFinal);
  const data = s.lead.buckets.map((b, i) => ({ label: LEAD_BUCKET_LABEL[b], current: cur[i]!, samePoint: sp[i]!, full: full[i]! }));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const within6 = full.slice(0, 4).reduce((a, b) => a + b, 0);
  return (
    <>
      <div className="chart-plot" style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={1}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 11 }} interval={0} axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
            <YAxis tickFormatter={pct} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip formatter={(v) => pct(Number(v))} />
            <Bar dataKey="full" name="Last season (full)" fill="var(--axis)" isAnimationActive={false} />
            <Bar dataKey="samePoint" name="Last season at the same point" fill={PREV} isAnimationActive={false} />
            <Bar dataKey="current" name="This season so far" fill={CUR} isAnimationActive={false} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {s.lead.previousFinal.some((n) => n > 0) && (
        <p className="card-subtitle">
          Last season, {pct(within6)} of guests bought 6 days or less before their day, and {pct(full[0]!)} bought the same day. Until the season ends, "this
          season so far" leans toward early buyers (late buyers for upcoming days haven't bought yet), so compare it with last season at the same point.
        </p>
      )}
    </>
  );
}

function WeekendBars({ title, weekends }: { title: string; weekends: WeekendLead[] }) {
  if (weekends.length === 0) return null;
  const data = weekends.map((w) => ({
    label: `${w.label} (${md(w.from)}–${md(w.to)}) · ${formatInt(w.guests)} guests`,
    ...Object.fromEntries(shares(w.groups).map((v, i) => [`g${i}`, v])),
  }));
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>{title}</div>
      <div className="legend" style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, marginBottom: 4 }}>
        {LEAD_GROUPS.map((g, i) => (
          <span key={g.label} className="legend-item">
            <span className="swatch" style={{ background: LEAD_COLORS[i] }} aria-hidden />
            {g.label}
          </span>
        ))}
      </div>
      <div className="chart-plot" style={{ height: 34 * data.length + 50 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} stackOffset="expand">
            <XAxis type="number" tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fill: "var(--text-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="label" width={210} tick={{ fill: "var(--text-secondary)", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v) => `${Math.round(Number(v) * 100)}%`} />
            {LEAD_GROUPS.map((g, i) => (
              <Bar key={g.label} dataKey={`g${i}`} name={g.label} stackId="a" fill={LEAD_COLORS[i]} isAnimationActive={false} />
            ))}

          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Each FareHarbor item and the ticket type it counts as; admins can correct one the name gets wrong. */
function TicketTypes({ items, itemTypes }: { items: string[]; itemTypes: Record<string, TicketType> }) {
  const isAdmin = useMe().data?.isAdmin ?? false;
  const settings = useSeasonSettings().data;
  const save = useSaveSeasonSettings();
  const setType = (item: string, type: TicketType | "") => {
    if (!settings) return;
    const next = { ...settings.fareharbor.itemTypes };
    if (type) next[item] = type;
    else delete next[item];
    void save.mutateAsync({ ...settings, fareharbor: { ...settings.fareharbor, itemTypes: next } });
  };
  return (
    <details style={{ marginTop: 12 }}>
      <summary className="muted">Ticket types ({items.length} FareHarbor items)</summary>
      <p className="card-subtitle">
        Each item counts as Town, Trail or Combo from its name (“Combo” first; “Upside Down”, “Express” or “Dinner” are packages, kept out of the
        year-over-year comparison). {isAdmin ? "Pick a type to correct one." : "Admins can correct one here."}
      </p>
      <div className="table-scroll">
        <table>
          <tbody>
            {items.map((item) => (
              <tr key={item}>
                <td>{item}</td>
                <td>
                  <select
                    value={itemTypes[item] ?? ""}
                    disabled={!isAdmin || !settings || save.isPending}
                    onChange={(e) => setType(item, e.target.value as TicketType | "")}
                    aria-label={`${item} ticket type`}
                  >
                    <option value="">From the name: {TICKET_TYPE_LABEL[ticketTypeFor(item)]}</option>
                    {TICKET_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TICKET_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Which season is shown: ?fhs= in the URL, else the server's choice (the season under way). */
function useSeasonParam() {
  const [params, setParams] = useSearchParams();
  const season = Number(params.get("fhs")) || undefined;
  const set = (s: number) => {
    const next = new URLSearchParams(params);
    next.set("fhs", String(s));
    setParams(next, { replace: true });
  };
  return [season, set] as const;
}

/**
 * FareHarbor bookings for one business line, season to date against last
 * season: days already held (final), upcoming days (sold so far, against last
 * season at the same point), day by day, by ticket type or item, and when
 * tickets were bought. Days are matched to last season by the closest same
 * weekday (364 days earlier).
 */
export function FareharborDetail({ businessLine, title }: { businessLine: BusinessLine; title: string }) {
  const [season, setSeason] = useSeasonParam();
  const q = useFareharborDays(businessLine, season);
  const [measure, setMeasure] = useState<"revenue" | "guests">("revenue");
  const s = useMemo(() => (q.data ? summarizeFareharbor(q.data) : null), [q.data]);
  const d = q.data;
  const nightly = d?.nightly ?? true;
  const unit = nightly ? "night" : "week";

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
        <div className="error-banner">Couldn't load FareHarbor bookings: {q.error.message}</div>
      </section>
    );
  }
  if (!d || !s) {
    return (
      <section className="page-section" aria-label={title}>
        {header}
        <div className="card empty">Loading…</div>
      </section>
    );
  }
  if (d.seasons.length === 0) {
    return (
      <section className="page-section" aria-label={title}>
        {header}
        <div className="card empty">
          No FareHarbor bookings for this business line yet. Check Settings → Business lines → FareHarbor, and that this line's FareHarbor company is
          connected (Status page).
        </div>
      </section>
    );
  }

  const seasonToDate: Metrics = {
    revenue: s.held.current.current.revenue + s.upcoming.current.current.revenue,
    guests: s.held.current.current.guests + s.upcoming.current.current.guests,
    byGroup: {},
  };
  // Every day last season had, as sold by the same point.
  const prevSamePointAll: Metrics = s.days.reduce<Metrics>(
    (t, x) => ({ revenue: t.revenue + (x.previousAtSamePoint?.revenue ?? 0), guests: t.guests + (x.previousAtSamePoint?.guests ?? 0), byGroup: {} }),
    { revenue: 0, guests: 0, byGroup: {} },
  );
  const past = d.asOf > d.current.end;
  const anyUpcoming = s.upcoming.current.days > 0 || s.upcoming.previousAtSamePoint.days > 0;
  const closures = d.closures.filter((c) => c.date >= d.previous.start && c.date <= d.current.end);

  return (
    <section className="page-section" aria-label={title}>
      {header}
      <p className="card-subtitle">
        {past ? `Season ${d.season} (final).` : `Bookings through ${formatDate(d.asOf)}.`} Each {unit} is compared with the closest same weekday last season
        (364 days earlier). "At the same point" = what last season had sold by {formatDate(d.samePointCutoff)}. Revenue is booking totals less refunds,
        before FareHarbor's processing fee.
        {closures.length > 0 && ` Left out: ${closures.map((c) => `${formatDate(c.date)} (${c.note.toLowerCase() || "closed"})`).join(", ")}, and their match the other year.`}
      </p>

      <div className="tiles">
        <Tile
          label="Revenue this season"
          value={seasonToDate.revenue}
          previous={past ? s.held.previous.current.revenue : prevSamePointAll.revenue}
          money
          note={past ? "vs last season" : "vs last season at the same point"}
        />
        <Tile label="Guests this season" value={seasonToDate.guests} previous={past ? s.held.previous.current.guests : prevSamePointAll.guests} />
        <div className="tile tile-small">
          <div className="tile-label">Revenue per guest</div>
          <div className="tile-value">{formatUsd(perGuest(seasonToDate))}</div>
          {s.held.matching.days > 0 && <Delta value={perGuest(s.held.matching.current)} previous={perGuest(s.held.matching.previous)} money />}
        </div>
        <Tile label={`${nightly ? "Nights" : "Weeks"} held`} value={s.held.current.days} previous={null} note={`${s.held.previous.days} last season`} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3 className="card-title">{nightly ? "Nights" : "Weeks"} already held — final</h3>
        </div>
        <TotalsTable
          s={s}
          nightly={nightly}
          rows={[
            { label: "This season", days: s.held.current.days, m: s.held.current.current, emphasis: true },
            { label: "Last season (whole season)", days: s.held.previous.days, m: s.held.previous.current },
            { label: `This season — ${unit}s open both years`, days: s.held.matching.days, m: s.held.matching.current, emphasis: true },
            { label: `Last season — the same ${unit}s, final`, days: s.held.matching.days, m: s.held.matching.previous },
            { label: `Last season — the same ${unit}s, at the same point`, days: s.held.matching.days, m: s.held.matching.previousAtSamePoint },
            ...(s.held.unmatched.days > 0 ? [{ label: `This season — ${unit}s with no match last season`, days: s.held.unmatched.days, m: s.held.unmatched.current }] : []),
          ]}
        />
        {nightly && <TicketTypes items={[...new Set(d.rows.map((r) => r.item))].sort()} itemTypes={d.itemTypes} />}
      </div>

      {!past && anyUpcoming && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3 className="card-title">Upcoming {unit}s — sold so far</h3>
          </div>
          <TotalsTable
            s={s}
            nightly={nightly}
            rows={[
              { label: "This season so far", days: s.upcoming.current.days, m: s.upcoming.current.current, emphasis: true },
              { label: "Last season at the same point", days: s.upcoming.previousAtSamePoint.days, m: s.upcoming.previousAtSamePoint.current },
            ]}
          />
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3 className="card-title">{nightly ? "Night" : "Week"} by {unit}</h3>
          <div className="chips">
            <label className="field field-inline">
              <span className="field-label">Show</span>
              <select value={measure} onChange={(e) => setMeasure(e.target.value as "revenue" | "guests")}>
                <option value="revenue">Revenue</option>
                <option value="guests">Guests</option>
              </select>
            </label>
          </div>
        </div>
        <p className="card-subtitle">Already held: final numbers both seasons.</p>
        <DayChart s={s} measure={measure} held />
        {!past && anyUpcoming && (
          <>
            <p className="card-subtitle" style={{ marginTop: 16 }}>Upcoming: sold so far, against last season at the same point.</p>
            <DayChart s={s} measure={measure} held={false} />
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3 className="card-title">When tickets are bought</h3>
        </div>
        <p className="card-subtitle">
          Share of guests by how many days before their {unit === "night" ? "night" : "activity"} they bought
          {nightly ? " (Town, Trail and Combo)" : ""}.
        </p>
        <LeadChart s={s} />
        {nightly && (
          <>
            <WeekendBars title="This season so far, by weekend" weekends={s.lead.byWeekend.current} />
            <WeekendBars title="Last season (full), by weekend" weekends={s.lead.byWeekend.previous} />
          </>
        )}
      </div>
    </section>
  );
}
