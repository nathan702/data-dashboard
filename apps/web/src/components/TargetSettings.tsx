import { useState } from "react";
import {
  BUSINESS_LINE_INFO,
  BUSINESS_LINES,
  easternDate,
  lineTargetMeasures,
  TARGET_MEASURE_INFO,
  TARGET_MEASURES,
  type BusinessLine,
  type TargetMeasure,
  type TargetSettings,
} from "@dash/shared";
import { useSaveTargetSettings, useTargetSettings } from "../lib/api";

/**
 * Settings → Targets: one season at a time, a row per business line and a box
 * per measure it can have. Empty boxes mean no target.
 */
export function TargetSettingsCard({ canEdit }: { canEdit: boolean }) {
  const { data, error } = useTargetSettings();
  const save = useSaveTargetSettings();
  const lines = BUSINESS_LINES;
  const thisYear = Number(easternDate().slice(0, 4));
  const [year, setYear] = useState(String(thisYear));
  const [draft, setDraft] = useState<TargetSettings | null>(null);
  const [saved, setSaved] = useState(false);
  if (error) return <div className="error-banner">Couldn't load targets: {error.message}</div>;
  if (!data) return null;
  const s = draft ?? data;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(data);
  const years = [...new Set([String(thisYear - 1), String(thisYear), String(thisYear + 1), ...Object.keys(s.seasons)])].sort().reverse();
  const values = s.seasons[year] ?? {};
  const columns = TARGET_MEASURES.filter((m) => lines.some((l) => lineTargetMeasures(l).includes(m)));

  const setValue = (line: BusinessLine, measure: TargetMeasure, raw: string) => {
    const n = raw.trim() === "" ? null : Number(raw.replace(/[$,\s]/g, ""));
    const lineValues = { ...(values[line] ?? {}) };
    if (n === null || !Number.isFinite(n) || n < 0) delete lineValues[measure];
    else lineValues[measure] = n;
    const season = { ...values, [line]: lineValues };
    if (Object.keys(lineValues).length === 0) delete season[line];
    const seasons = { ...s.seasons, [year]: season };
    if (Object.keys(season).length === 0) delete seasons[year];
    setDraft({ seasons });
    setSaved(false);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Targets</h2>
        <label className="field field-inline">
          <span className="field-label">Season</span>
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
                {s.seasons[y] ? " ✓" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="card-subtitle">
        A goal for each business line's season (its dates are set on the Seasons tab). Each line's page compares where it is now with where it would be
        by now at last season's pace; Camp lines up by days since registration opened. Leave a box empty for no target.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Business line</th>
              {columns.map((m) => (
                <th key={m} className="num" title={TARGET_MEASURE_INFO[m].help}>
                  {TARGET_MEASURE_INFO[m].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line}>
                <td>{BUSINESS_LINE_INFO[line].label}</td>
                {columns.map((m) => (
                  <td key={m} className="num">
                    {lineTargetMeasures(line).includes(m) ? (
                      <input
                        className="targets-input"
                        type="number"
                        min={0}
                        step={TARGET_MEASURE_INFO[m].money ? 1000 : 1}
                        inputMode="numeric"
                        placeholder={TARGET_MEASURE_INFO[m].money ? "$" : "–"}
                        aria-label={`${BUSINESS_LINE_INFO[line].label} ${TARGET_MEASURE_INFO[m].label} target, ${year}`}
                        value={values[line]?.[m] ?? ""}
                        disabled={!canEdit}
                        onChange={(e) => setValue(line, m, e.target.value)}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          {saved && !dirty && <span className="hint">✓ Saved</span>}
          {dirty && (
            <button type="button" className="button" onClick={() => setDraft(null)}>
              Undo changes
            </button>
          )}
          <button
            type="button"
            className="button button-primary"
            disabled={!dirty || save.isPending}
            onClick={() =>
              void save.mutateAsync(s).then(() => {
                setDraft(null);
                setSaved(true);
              })
            }
          >
            {save.isPending ? "Saving…" : dirty ? "Save targets" : "No changes"}
          </button>
        </div>
      )}
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
    </div>
  );
}
