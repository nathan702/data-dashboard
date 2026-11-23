import { useState } from "react";
import {
  BUSINESS_LINE_INFO,
  BUSINESS_LINES,
  campminderCalendar,
  easternDate,
  isIsoDate,
  laborDay,
  lineCalendar,
  REGISTRATION_WAVE_LABEL,
  REGISTRATION_WAVES,
  SEASON_RULE_LABEL,
  SEASON_RULES,
  type BusinessLine,
  type CampLocation,
  type RegistrationSettings,
  type SeasonRule,
  type SeasonSettings,
  type FareharborSettings,
  HUBSPOT_ROLES,
  HUBSPOT_ROLE_KIND,
  HUBSPOT_ROLE_LABEL,
  resolveCampExtras,
  resolveHubspotRoles,
  type HubspotSettings,
} from "@dash/shared";
import { useAssignments, useCampItems, useHubspotProperties, useSaveSeasonSettings, useSeasonSettings } from "../lib/api";
import { formatDate, formatInt, formatUsd } from "../lib/format";

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
  const invalid = [
    ...Object.values(s.endDates).flatMap((m) => Object.values(m ?? {})),
    ...Object.values(s.campminderStarts),
    ...Object.values(s.registration.opens).flatMap((o) => Object.values(o)),
  ].some((d) => !isIsoDate(d));
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
      <RegistrationSection value={s.registration} canEdit={canEdit} onChange={(registration) => update({ ...s, registration })} />
      <ClosuresSection value={s.fareharbor} canEdit={canEdit} onChange={(fareharbor) => update({ ...s, fareharbor })} />
      <HubspotRolesSection value={s.hubspot} canEdit={canEdit} onChange={(hubspot) => update({ ...s, hubspot })} />
      <CampExtrasSection value={s.campExtras} canEdit={canEdit} onChange={(campExtras) => update({ ...s, campExtras })} />
    </section>
  );
}

/** Camp registration waves: when each opened, and which camp session groups are in Virginia or Maryland. */
function RegistrationSection({ value, canEdit, onChange }: { value: RegistrationSettings; canEdit: boolean; onChange(v: RegistrationSettings): void }) {
  const assignments = useAssignments().data?.rows ?? [];
  const campGroups = assignments.filter((r) => r.source === "campminder" && r.kind === "session" && r.businessLine === "camp").map((r) => r.key);
  const groups = [...new Set([...campGroups, ...Object.keys(value.locations)])].sort((a, b) => a.localeCompare(b));
  const years = Object.keys(value.opens).sort().reverse();
  const nextYear = years.length ? Number(years[0]) + 1 : thisYear();
  const setDate = (year: string, wave: (typeof REGISTRATION_WAVES)[number], date: string) =>
    onChange({ ...value, opens: { ...value.opens, [year]: { ...value.opens[year], [wave]: date } } });
  const setLocation = (group: string, loc: CampLocation | "") => {
    const locations = { ...value.locations };
    if (loc) locations[group] = loc;
    else delete locations[group];
    onChange({ ...value, locations });
  };
  return (
    <div className="season-campminder">
      <h3 className="card-title">Camp registration</h3>
      <p className="card-subtitle">
        The day registration opened for each group of families, for the Camp page's “Sign-ups since registration opened” chart. A family is
        returning when one of its campers was at a camp location below last season (the earlier wave if it was at both); everyone else is
        new.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Season</th>
              {REGISTRATION_WAVES.map((w) => (
                <th key={w}>{REGISTRATION_WAVE_LABEL[w]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}>
                <td>{y}</td>
                {REGISTRATION_WAVES.map((w) => (
                  <td key={w}>
                    <input
                      type="date"
                      value={value.opens[y]?.[w] ?? ""}
                      disabled={!canEdit}
                      aria-label={`${y} ${REGISTRATION_WAVE_LABEL[w]} opened`}
                      onChange={(e) => setDate(y, w, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <button
          type="button"
          className="link-button"
          onClick={() => onChange({ ...value, opens: { ...value.opens, [String(nextYear)]: { va: `${nextYear}-01-06`, md: `${nextYear}-01-08`, new: `${nextYear}-01-13` } } })}
        >
          + {nextYear}
        </button>
      )}
      <h3 className="card-title">Camp locations</h3>
      <p className="card-subtitle">Which state each camp session group meets in. Groups left blank (LIT, trips…) don't decide a family's wave.</p>
      <div className="year-dates">
        {groups.map((g) => (
          <label key={g} className="year-date">
            <span className="chip-label">{g}</span>
            <select value={value.locations[g] ?? ""} disabled={!canEdit} onChange={(e) => setLocation(g, e.target.value as CampLocation | "")} aria-label={`${g} location`}>
              <option value="">—</option>
              <option value="va">Virginia</option>
              <option value="md">Maryland</option>
            </select>
          </label>
        ))}
      </div>
      <h3 className="card-title">Returning families</h3>
      <p className="card-subtitle">
        The oldest a camper can be on June 1 and still come back to Camp. Last season's campers older than this next summer have aged out:
        the Camp page's Returning families card doesn't count them as still to come back. Leave blank for automatic (the oldest age at least
        1% of last season's campers were).
      </p>
      <AgeOutField value={value.ageOutAfter} canEdit={canEdit} onChange={(ageOutAfter) => onChange({ ...value, ageOutAfter })} />
    </div>
  );
}

/** The age-out age: typed freely, saved once it's a whole number from 3 to 25 (or blank: automatic). */
function AgeOutField({ value, canEdit, onChange }: { value: number | null; canEdit: boolean; onChange(v: number | null): void }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const n = Number(draft);
  const valid = draft.trim() === "" || (Number.isInteger(n) && n >= 3 && n <= 25);
  return (
    <label className="field field-inline">
      <span className="field-label">Oldest camper age</span>
      <input
        type="number"
        min={3}
        max={25}
        step={1}
        placeholder="Automatic"
        value={draft}
        disabled={!canEdit}
        aria-label="Oldest camper age on June 1"
        aria-invalid={!valid}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          const v = Number(next);
          if (next.trim() === "") onChange(null);
          else if (Number.isInteger(v) && v >= 3 && v <= 25) onChange(v);
        }}
      />
      {!valid && <span className="hint">A whole number from 3 to 25</span>}
    </label>
  );
}

/** FareHarbor days the business was closed (weather, cancelled): left out of both seasons' comparisons. */
function ClosuresSection({ value, canEdit, onChange }: { value: FareharborSettings; canEdit: boolean; onChange(v: FareharborSettings): void }) {
  const lines = BUSINESS_LINES.filter((l) => BUSINESS_LINE_INFO[l].sources.includes("fareharbor"));
  const rows = value.closures.map((c, i) => ({ ...c, i })).sort((a, b) => b.date.localeCompare(a.date));
  const setRow = (i: number, patch: Partial<FareharborSettings["closures"][number]>) =>
    onChange({ ...value, closures: value.closures.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="season-campminder">
      <h3 className="card-title">Closed days (FareHarbor)</h3>
      <p className="card-subtitle">
        Nights or days that were closed (weather) or cancelled. They're left out of the FareHarbor sections on each business line's page, and so is
        their match the other year (the closest same weekday). Refunded tickets drop out on their own; guests who moved show on their new day.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Business line</th>
              <th>Date</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.i}>
                <td>
                  <select value={c.businessLine} disabled={!canEdit} onChange={(e) => setRow(c.i, { businessLine: e.target.value as BusinessLine })} aria-label="Business line">
                    {lines.map((l) => (
                      <option key={l} value={l}>
                        {BUSINESS_LINE_INFO[l].label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="date" value={c.date} disabled={!canEdit} onChange={(e) => isIsoDate(e.target.value) && setRow(c.i, { date: e.target.value })} aria-label="Closed date" />
                </td>
                <td>
                  <input type="text" value={c.note} maxLength={200} disabled={!canEdit} onChange={(e) => setRow(c.i, { note: e.target.value })} aria-label="Reason" placeholder="Weather" />
                </td>
                <td>
                  {canEdit && (
                    <button type="button" className="link-button" onClick={() => onChange({ ...value, closures: value.closures.filter((_, j) => j !== c.i) })}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <button
          type="button"
          className="link-button"
          onClick={() => onChange({ ...value, closures: [...value.closures, { businessLine: lines[0] ?? "haunted_forest", date: easternDate(), note: "Weather" }] })}
        >
          + Add a closed day
        </button>
      )}
    </div>
  );
}

/** Which HubSpot deal properties are participants, chaperones, program type, food and transportation. */
function HubspotRolesSection({ value, canEdit, onChange }: { value: HubspotSettings; canEdit: boolean; onChange(v: HubspotSettings): void }) {
  const properties = useHubspotProperties().data?.properties ?? [];
  const guessed = resolveHubspotRoles({ participants: [], chaperones: [], programType: [], food: [], transportation: [] }, properties);
  const label = (names: string[]) => names.map((n) => properties.find((p) => p.name === n)?.label ?? n).join(" + ");
  return (
    <div className="season-campminder">
      <h3 className="card-title">HubSpot properties</h3>
      <p className="card-subtitle">
        Which deal properties the Education Programs and CHAPs pages use. Counts can add up several properties (e.g. free + paid chaperones): tick each
        one. Left on “Automatic”, properties whose label fits are used (for chaperones, all of them added up). The program date is the{" "}
        <code>start_datetime</code> property.
      </p>
      {properties.length === 0 ? (
        <div className="muted">No HubSpot properties yet (they appear after the first HubSpot sync).</div>
      ) : (
        <div className="table-scroll">
          <table>
            <tbody>
              {HUBSPOT_ROLES.map((role) => {
                const kind = HUBSPOT_ROLE_KIND[role];
                const choices = properties.filter((p) => (kind === "number" ? p.type === "number" : p.type === "enumeration" || p.type === "bool"));
                const auto = guessed[role].length ? `Automatic (${label(guessed[role])})` : "Automatic (none found)";
                const set = value[role] ?? [];
                return (
                  <tr key={role}>
                    <td style={{ verticalAlign: "top", fontWeight: 500 }}>{HUBSPOT_ROLE_LABEL[role]}</td>
                    <td style={{ whiteSpace: "normal" }}>
                      {kind === "choice" ? (
                        <select
                          value={set[0] ?? ""}
                          disabled={!canEdit}
                          onChange={(e) => onChange({ ...value, [role]: e.target.value ? [e.target.value] : [] })}
                          aria-label={`${HUBSPOT_ROLE_LABEL[role]} property`}
                        >
                          <option value="">{auto}</option>
                          {choices.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
                          <span className="muted">{set.length ? `Adding up: ${label(set)}` : auto}</span>
                          {choices.map((p) => (
                            <label key={p.name} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <input
                                type="checkbox"
                                checked={set.includes(p.name)}
                                disabled={!canEdit}
                                onChange={(e) =>
                                  onChange({ ...value, [role]: e.target.checked ? [...set, p.name] : set.filter((n) => n !== p.name) })
                                }
                              />
                              {p.label}
                            </label>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Which Summer Camp line items count as camp extras (lunches, gear…) rather than tuition. */
function CampExtrasSection({ value, canEdit, onChange }: { value: string[] | null; canEdit: boolean; onChange(v: string[] | null): void }) {
  const q = useCampItems();
  const items = q.data?.items ?? [];
  // Until something is chosen, the automatic set (lunches, gear, cancellation fees) is what's ticked.
  const chosen = value ?? resolveCampExtras(null, items.map((i) => i.item));
  return (
    <div className="season-campminder">
      <h3 className="card-title">Camp extras</h3>
      <p className="card-subtitle">
        Which Summer Camp line items the Camp page's Camp extras card lists (the rest are tuition). Only the Summer Camp financial category counts;
        Miscellaneous lines are their own “Financial category: Miscellaneous” entry on the Campminder tab, counted wherever it's assigned. Weeks are dropped from names, so every “Week 3 Lunch” is Lunch.
        {value === null && " Automatic for now: lunches, gear bags, backpacks and cancellation fees."}
      </p>
      {q.error && <div className="error-banner">Couldn't load line items: {q.error.message}</div>}
      {items.length === 0 ? (
        <div className="muted">No Summer Camp line items yet (they appear after the Campminder Financial tab is imported).</div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Extra</th>
                  <th>Line item</th>
                  <th className="num">Lines</th>
                  <th className="num">Net amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.item}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${i.item} is a camp extra`}
                        checked={chosen.includes(i.item)}
                        disabled={!canEdit}
                        onChange={(e) => onChange(e.target.checked ? [...chosen, i.item] : chosen.filter((x) => x !== i.item))}
                      />
                    </td>
                    <td>{i.item}</td>
                    <td className="num">{formatInt(i.lines)}</td>
                    <td className="num">{formatUsd(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && value !== null && (
            <button type="button" className="button" style={{ marginTop: 8 }} onClick={() => onChange(null)}>
              Back to automatic
            </button>
          )}
        </>
      )}
    </div>
  );
}
