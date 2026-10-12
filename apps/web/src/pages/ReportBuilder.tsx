import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  addDays,
  easternDate,
  REPORT_DATASET_INFO,
  REPORT_DATASETS,
  reportSpecSchema,
  type ReportChart,
  type ReportDataset,
  type ReportPercent,
  type ReportSpec,
} from "@dash/shared";
import { FilterChips } from "../components/FilterChips";
import { ReportView } from "../components/ReportView";
import { useReportMutations, useReportValues, useRunReport, useSavedReport } from "../lib/api";
import { buildPivot, displayValue } from "../lib/pivot";

const CHART_LABEL: Record<ReportChart, string> = { table: "Table", bar: "Bar chart", line: "Line chart", heatmap: "Heat map" };

function defaultSpec(dataset: ReportDataset): ReportSpec {
  const info = REPORT_DATASET_INFO[dataset];
  const today = easternDate();
  return reportSpecSchema.parse({
    dataset,
    rows: [info.dated ? "month" : "season"],
    measure: info.defaultMeasure,
    ...(info.dated ? { start: addDays(today, -364), end: today } : {}),
  });
}

/** The report being edited lives in the URL (?spec=…), so Back undoes and links share unsaved work. */
function useSpecState(saved: ReportSpec | undefined) {
  const [params, setParams] = useSearchParams();
  let fromUrl: ReportSpec | null = null;
  try {
    const raw = params.get("spec");
    if (raw) {
      const parsed = reportSpecSchema.safeParse(JSON.parse(raw));
      if (parsed.success) fromUrl = parsed.data;
    }
  } catch {
    // Bad link: fall back to the saved report.
  }
  const spec = fromUrl ?? saved ?? null;
  const setSpec = (next: ReportSpec, push = false) => {
    const parsed = reportSpecSchema.safeParse(next);
    if (!parsed.success) return; // controls only offer valid choices; ignore half-made states
    const p = new URLSearchParams(params);
    p.set("spec", JSON.stringify(parsed.data));
    setParams(p, { replace: !push });
  };
  return [spec, setSpec, !!fromUrl] as const;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/** Build, run and save a report. /reports/new starts fresh; /reports/:id opens a saved one. */
export function ReportBuilder() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const saved = useSavedReport(isNew ? undefined : id);
  const [spec, setSpec, edited] = useSpecState(isNew ? defaultSpec("enrollments") : saved.data?.spec);
  const run = useRunReport(spec);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState<null | "new" | "update">(null);

  if (!isNew && saved.error) return <div className="page"><div className="error-banner">Couldn't open this report: {saved.error.message}</div></div>;
  if (!spec) return <div className="loading">Loading…</div>;

  const info = REPORT_DATASET_INFO[spec.dataset];
  const measure = info.measures.find((m) => m.id === spec.measure)!;
  const fieldLabel = (fid: string) => info.fields.find((f) => f.id === fid)?.label ?? fid;
  const used = new Set([...spec.rows, spec.column].filter(Boolean));
  const fieldOptions = (current: string | undefined) => info.fields.filter((f) => f.id === current || !used.has(f.id));
  const percentOptions: Array<[ReportPercent, string]> = [
    ["none", measure.format === "money" ? "Amounts" : "Values"],
    ...(spec.column && spec.rows.length ? ([["row", "% of row"], ["column", "% of column"]] as Array<[ReportPercent, string]>) : []),
    ...((spec.rows.length || spec.column) ? ([["total", "% of total"]] as Array<[ReportPercent, string]>) : []),
  ];
  const update = (patch: Partial<ReportSpec>, push = false) => {
    const next = { ...spec, ...patch };
    if (!info.measures.find((m) => m.id === next.measure)?.additive) next.percent = "none";
    if ((next.percent === "row" || next.percent === "column") && !(next.column && next.rows.length)) next.percent = "none";
    setSpec(next, push);
  };
  const active = Object.entries(spec.filters).filter(([, v]) => v.length > 0) as Array<[string, string[]]>;
  const drill = (row: string[] | null, col: string | null) => {
    const filters = { ...spec.filters };
    row?.forEach((v, i) => (filters[spec.rows[i]!] = [v]));
    if (col !== null && spec.column) filters[spec.column] = [col];
    update({ filters }, true);
  };
  const title = isNew ? "New report" : saved.data?.name ?? "Report";
  const canEdit = !isNew && !!saved.data?.canEdit;
  const dirty = isNew || (edited && JSON.stringify(spec) !== JSON.stringify(saved.data?.spec));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="hint">
            <Link to="/reports">Reports</Link> ›
          </p>
          <h1>{title}</h1>
          {saved.data?.description && <p className="card-subtitle">{saved.data.description}</p>}
        </div>
        <div className="chips">
          {canEdit && dirty && (
            <button type="button" className="button button-primary" onClick={() => setSaving("update")}>
              Save
            </button>
          )}
          <button type="button" className={`button${!canEdit && dirty ? " button-primary" : ""}`} onClick={() => setSaving("new")}>
            {isNew ? "Save report" : canEdit ? "Save as new…" : "Save a copy"}
          </button>
        </div>
      </header>

      {saving && (
        <SaveForm
          mode={saving}
          spec={spec}
          existing={saving === "update" ? saved.data : undefined}
          suggestedName={isNew ? "" : saving === "new" ? `${title} (copy)` : title}
          onDone={() => setSaving(null)}
        />
      )}

      <section className="card report-controls" aria-label="Report setup">
        <div className="filter-bar">
          <Field label="Data">
            <select value={spec.dataset} onChange={(e) => setSpec(defaultSpec(e.target.value as ReportDataset), true)}>
              {REPORT_DATASETS.map((d) => (
                <option key={d} value={d}>
                  {REPORT_DATASET_INFO[d].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Measure">
            <select value={spec.measure} onChange={(e) => update({ measure: e.target.value })} title={measure.description}>
              {info.measures.map((m) => (
                <option key={m.id} value={m.id} title={m.description}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rows">
            <select
              value={spec.rows[0] ?? ""}
              onChange={(e) => update({ rows: e.target.value ? [e.target.value, ...spec.rows.slice(1).filter((r) => r !== e.target.value)] : [] })}
            >
              <option value="">(none)</option>
              {fieldOptions(spec.rows[0]).map((f) => (
                <option key={f.id} value={f.id} title={f.description}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          {spec.rows.length > 0 && (
            <Field label="Then by">
              <select value={spec.rows[1] ?? ""} onChange={(e) => update({ rows: e.target.value ? [spec.rows[0]!, e.target.value] : [spec.rows[0]!] })}>
                <option value="">(none)</option>
                {fieldOptions(spec.rows[1]).map((f) => (
                  <option key={f.id} value={f.id} title={f.description}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Columns">
            <select value={spec.column ?? ""} onChange={(e) => update({ column: e.target.value || undefined })}>
              <option value="">(none)</option>
              {fieldOptions(spec.column).map((f) => (
                <option key={f.id} value={f.id} title={f.description}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Show">
            <select value={spec.percent} onChange={(e) => update({ percent: e.target.value as ReportPercent })} disabled={!measure.additive}>
              {percentOptions.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {info.dated && (
            <>
              <Field label="From">
                <input type="date" value={spec.start} onChange={(e) => e.target.value && update({ start: e.target.value })} />
              </Field>
              <Field label="To">
                <input type="date" value={spec.end} onChange={(e) => e.target.value && update({ end: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <div className="segmented" role="tablist" aria-label="Show as">
          {(Object.keys(CHART_LABEL) as ReportChart[]).map((c) => (
            <button key={c} type="button" role="tab" aria-selected={spec.chart === c} onClick={() => update({ chart: c })}>
              {CHART_LABEL[c]}
            </button>
          ))}
        </div>
        <p className="hint">
          {info.description} <strong>{measure.label}:</strong> {measure.description}
        </p>
      </section>

      <FilterChips
        active={active}
        label={fieldLabel}
        valueLabel={(fid, v) => displayValue(info.fields.find((f) => f.id === fid) ?? null, v)}
        onRemove={(fid) => {
          const filters = { ...spec.filters };
          delete filters[fid];
          update({ filters }, true);
        }}
        onClear={() => update({ filters: {} }, true)}
      >
        <button type="button" className="button" onClick={() => setPicking((x) => !x)} aria-expanded={picking}>
          + Filter
        </button>
      </FilterChips>
      {picking && (
        <ReportFilterPicker
          spec={spec}
          onApply={(fid, values) => {
            const filters = { ...spec.filters };
            if (values.length) filters[fid] = values;
            else delete filters[fid];
            update({ filters }, true);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}

      {run.error && <div className="error-banner">Couldn't run this report: {run.error.message}</div>}
      {run.data && (
        <div className={run.isPlaceholderData ? "refetching" : undefined}>
          {run.data.truncated && <p className="notice">Showing the first 5,000 cells. Add a filter to narrow it down.</p>}
          <ReportView
            pivot={buildPivot(run.data, info)}
            chart={spec.chart}
            onDrill={drill}
            exportName={(saved.data?.name ?? "report").replace(/[^\w-]+/g, "_").toLowerCase()}
          />
        </div>
      )}
      {!run.data && !run.error && <div className="loading">Running…</div>}
    </div>
  );
}

function ReportFilterPicker({ spec, onApply, onCancel }: { spec: ReportSpec; onApply(field: string, values: string[]): void; onCancel(): void }) {
  const info = REPORT_DATASET_INFO[spec.dataset];
  const [field, setField] = useState(info.fields[0]!.id);
  const [chosen, setChosen] = useState<string[]>(spec.filters[field] ?? []);
  const [query, setQuery] = useState("");
  const values = useReportValues(spec, field);
  const f = info.fields.find((x) => x.id === field)!;
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => (values.data?.values ?? []).filter((v) => !q || displayValue(f, v.value).toLowerCase().includes(q)),
    [values.data, q, f],
  );
  const toggle = (v: string) => setChosen((c) => (c.includes(v) ? c.filter((x) => x !== v) : [...c, v]));
  return (
    <div className="card filter-picker">
      <div className="filter-bar">
        <Field label="Filter by">
          <select
            value={field}
            onChange={(e) => {
              setField(e.target.value);
              setChosen(spec.filters[e.target.value] ?? []);
              setQuery("");
            }}
          >
            {info.fields.map((x) => (
              <option key={x.id} value={x.id} title={x.description}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type to narrow the list" />
        </Field>
      </div>
      {values.error && <div className="error-banner">Couldn't load values: {values.error.message}</div>}
      <div className="filter-values" role="group" aria-label={`${f.label} values`}>
        {rows.slice(0, 500).map((v) => (
          <label key={v.value}>
            <input type="checkbox" checked={chosen.includes(v.value)} onChange={() => toggle(v.value)} />
            {displayValue(f, v.value)}
            <span className="muted">{new Intl.NumberFormat("en-US").format(Math.round(v.count))}</span>
          </label>
        ))}
        {values.data && rows.length === 0 && <span className="hint">No values match.</span>}
        {rows.length > 500 && <span className="hint">Showing 500 of {rows.length}; search to narrow it down.</span>}
      </div>
      <div className="chips">
        <button type="button" className="button button-primary" onClick={() => onApply(field, chosen)}>
          Apply
        </button>
        {q && rows.length > 0 && rows.length <= 500 && (
          <button type="button" className="link-button" onClick={() => setChosen((c) => [...new Set([...c, ...rows.map((r) => r.value)])])}>
            Select all {rows.length} matching
          </button>
        )}
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SaveForm({
  mode,
  spec,
  existing,
  suggestedName,
  onDone,
}: {
  mode: "new" | "update";
  spec: ReportSpec;
  existing?: { id: string; name: string; description: string; shared: boolean };
  suggestedName: string;
  onDone(): void;
}) {
  const { create, update } = useReportMutations();
  const navigate = useNavigate();
  const [name, setName] = useState(existing?.name ?? suggestedName);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [shared, setShared] = useState(existing?.shared ?? false);
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const submit = async () => {
    const body = { name: name.trim(), description, shared, spec };
    if (mode === "update" && existing) {
      await update.mutateAsync({ id: existing.id, body });
      navigate(`/reports/${existing.id}`, { replace: true });
    } else {
      const r = await create.mutateAsync(body);
      navigate(`/reports/${r.id}`);
    }
    onDone();
  };
  return (
    <form
      className="card save-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="filter-bar">
        <Field label="Name">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
        </Field>
        <Field label="Description (optional)">
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone
        </label>
      </div>
      {error && <div className="error-banner">Couldn't save: {error.message}</div>}
      <div className="chips">
        <button type="submit" className="button button-primary" disabled={!name.trim() || pending}>
          {pending ? "Saving…" : mode === "update" ? "Save changes" : "Save"}
        </button>
        <button type="button" className="link-button" onClick={onDone}>
          Cancel
        </button>
        {mode === "update" && existing && <DeleteButton id={existing.id} />}
      </div>
    </form>
  );
}

function DeleteButton({ id }: { id: string }) {
  const { remove } = useReportMutations();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <>
      <span className="hint">Delete this report for everyone?</span>
      <button
        type="button"
        className="button"
        onClick={() => void remove.mutateAsync(id).then(() => navigate("/reports", { replace: true }))}
        disabled={remove.isPending}
      >
        Yes, delete
      </button>
    </>
  ) : (
    <button type="button" className="link-button danger" onClick={() => setConfirming(true)}>
      Delete report
    </button>
  );
}
