import { useState } from "react";
import {
  BUSINESS_LINE_INFO,
  BUSINESS_LINES,
  campminderCalendar,
  easternDate,
  isIsoDate,
  laborDay,
  lineCalendar,
  SEASON_RULE_LABEL,
  SEASON_RULES,
  type BusinessLine,
  type SeasonRule,
  type SeasonSettings,
} from "@dash/shared";
import { useSaveSeasonSettings, useSeasonSettings } from "../lib/api";
import { formatDate } from "../lib/format";

const thisYear = () => Number(easternDate().slice(0, 4));

/** Year → date list editor (Haunted Forest end dates, Campminder start overrides). */
function YearDates({
  values,
  onChange,
  disabled,
  placeholder,
  firstYear = thisYear(),
}: {
  /** Year offered when the list is empty. */
  firstYear?: number;
  values: Record<string, string>;
  onChange(v: Record<string, string>): void;
  disabled: boolean;
  placeholder: (year: number) => string;
}) {
  const years = Object.keys(values).sort();
  const nextYear = years.length ? Number(years[years.length - 1]) + 1 : firstYear;
  return (
    <div className="year-dates">
      {years.map((y) => (
        <span key={y} className="year-date">
          <span className="chip-label">{y}</span>
          <input
            type="date"
            value={values[y]}
            disabled={disabled}
            aria-label={`${y} date`}
            onChange={(e) => onChange({ ...values, [y]: e.target.value })}
          />
          {!disabled && (
            <button
              type="button"
              className="link-button"
              aria-label={`Remove ${y}`}
              onClick={() => {
                const next = { ...values };
                delete next[y];
                onChange(next);
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <button type="button" className="link-button" onClick={() => onChange({ ...values, [String(nextYear)]: placeholder(nextYear) })}>
          + {nextYear}
        </button>
      )}
    </div>
  );
}

/** Admins set how each business line's seasons run; everyone can see it. */
export function SeasonSettingsCard({ canEdit }: { canEdit: boolean }) {
  const { data, error } = useSeasonSettings();
  const save = useSaveSeasonSettings();
  const [draft, setDraft] = useState<SeasonSettings | null>(null);
  const [saved, setSaved] = useState(false);
  if (error) return <div className="error-banner">Couldn't load season settings: {error.message}</div>;
  if (!data) return null;

  const s = draft ?? data;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(data);
  const invalid = [...Object.values(s.endDates).flatMap((m) => Object.values(m ?? {})), ...Object.values(s.campminderStarts)].some((d) => !isIsoDate(d));
  const update = (next: SeasonSettings) => {
    setSaved(false);
    setDraft(next);
  };
  const setRule = (line: BusinessLine, rule: SeasonRule) => {
    const endDates = { ...s.endDates };
    if (rule === "end_dates" && !endDates[line]) endDates[line] = { [String(thisYear())]: `${thisYear()}-11-01` };
    update({ ...s, rules: { ...s.rules, [line]: rule }, endDates });
  };
  const today = easternDate();
  const cm = campminderCalendar(s.campminderStarts);
  const cmNow = cm.seasonFor(today);

  return (
    <section className="table-card season-settings" aria-label="Seasons">
      <div className="table-toolbar">
        <h2 className="table-title">Seasons</h2>
        <div className="table-actions">
          {saved && !dirty && <span className="hint">✓ Saved</span>}
          {canEdit && dirty && (
            <button type="button" className="button" onClick={() => setDraft(null)}>
              Discard
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="button button-primary"
              disabled={!dirty || invalid || save.isPending}
              onClick={() =>
                void save.mutateAsync(s).then(() => {
                  setSaved(true);
                  setDraft(null);
                })
              }
            >
              {save.isPending ? "Saving…" : dirty ? "Save seasons" : "No changes"}
            </button>
          )}
        </div>
      </div>
      <p className="card-subtitle season-intro">
        Each line's numbers are grouped into seasons by program or activity date. “Season to date”, “Last season” and “By season”
        follow these. Seasons are named by the year they end in.
      </p>
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Business line</th>
              <th>Season rule</th>
              <th>Current season</th>
              <th>Season end dates</th>
            </tr>
          </thead>
          <tbody>
            {BUSINESS_LINES.map((line) => {
              const cal = lineCalendar(line, s);
              const season = cal.seasonFor(today);
              const r = cal.range(season);
              return (
                <tr key={line}>
                  <td>{BUSINESS_LINE_INFO[line].label}</td>
                  <td>
                    <select value={s.rules[line]} disabled={!canEdit} onChange={(e) => setRule(line, e.target.value as SeasonRule)} aria-label={`${BUSINESS_LINE_INFO[line].label} season rule`}>
                      {SEASON_RULES.map((rule) => (
                        <option key={rule} value={rule}>
                          {SEASON_RULE_LABEL[rule]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {season}: {formatDate(r.start)} – {formatDate(r.end)}
                  </td>
                  <td>
                    {s.rules[line] === "end_dates" ? (
                      <>
                        <YearDates
                          values={s.endDates[line] ?? {}}
                          disabled={!canEdit}
                          placeholder={(y) => `${y}-${cal.lastDay(y).slice(5)}`}
                          onChange={(v) => update({ ...s, endDates: { ...s.endDates, [line]: v } })}
                        />
                        <span className="hint">Last day of each season. Years not listed reuse the nearest year's date.</span>
                      </>
                    ) : (
                      <span className="hint">{s.rules[line] === "calendar" ? "Dec 31" : "Day before Labor Day (see below)"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="season-campminder">
        <h3 className="card-title">Campminder seasons</h3>
        <p className="card-subtitle">
          Campminder's own seasons decide sign-up pace and “same point last season” for enrollments. A season starts on Labor Day
          (programs on or after it count toward the next season). Season {cmNow} started {formatDate(cm.range(cmNow).start)}. Add a year
          only if its season starts on a different day.
        </p>
        <YearDates
          values={s.campminderStarts}
          firstYear={cmNow + 1}
          disabled={!canEdit}
          placeholder={(y) => laborDay(y - 1)}
          onChange={(v) => update({ ...s, campminderStarts: v })}
        />
      </div>
    </section>
  );
}
