import { useState } from "react";
import type { SchoolSettings } from "@dash/shared";
import { useSaveSchools, useSchools } from "../lib/api";
import { formatInt } from "../lib/format";

/**
 * Which school each spelling families typed belongs to, for reports. Spellings
 * that differ only in form are grouped automatically ("Lowell" / "The Lowell
 * School"); admins add the rest ("SFS" → Sidwell Friends School) or split a
 * wrong grouping by giving a spelling its own name.
 */
export function SchoolsCard({ canEdit }: { canEdit: boolean }) {
  const { data, error } = useSchools();
  const save = useSaveSchools();
  // Spelling → school typed here; null puts the spelling back on automatic grouping.
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState("");
  if (error) return <div className="error-banner">Couldn't load schools: {error.message}</div>;
  if (!data) return null;

  const current = (entered: string) => {
    if (entered in edits) return edits[entered] ?? "";
    return data.overrides[entered] ?? "";
  };
  const changed = Object.keys(edits).length > 0;
  const groupSize = new Map<string, number>();
  for (const s of data.spellings) if (s.school) groupSize.set(s.school, (groupSize.get(s.school) ?? 0) + 1);
  const q = query.trim().toLowerCase();
  const shown = data.spellings
    .filter((s) => !q || s.entered.toLowerCase().includes(q) || (s.school ?? "").toLowerCase().includes(q))
    // Each school's spellings together, so a grouping can be checked at a glance.
    .sort((a, b) => (a.school ?? "￿").localeCompare(b.school ?? "￿") || b.campers - a.campers || a.entered.localeCompare(b.entered));

  const submit = async () => {
    const overrides: SchoolSettings["overrides"] = { ...data.overrides };
    for (const [entered, school] of Object.entries(edits)) {
      if (school === null || !school.trim()) delete overrides[entered];
      else overrides[entered] = school.trim();
    }
    await save.mutateAsync({ overrides });
    setEdits({});
    setSaved(true);
  };
  const setSchool = (entered: string, value: string | null) => {
    setSaved(false);
    setEdits((all) => ({ ...all, [entered]: value }));
  };

  return (
    <section className="table-card" aria-label="Schools">
      <div className="table-toolbar">
        <h2 className="table-title">Schools</h2>
        <div className="table-actions">
          <input type="search" placeholder="Search schools…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search schools" />
          {saved && !changed && <span className="hint">✓ Saved. Reports use it right away.</span>}
          {canEdit && changed && (
            <button type="button" className="button" onClick={() => setEdits({})}>
              Discard
            </button>
          )}
          {canEdit && (
            <button type="button" className="button button-primary" disabled={!changed || save.isPending} onClick={() => void submit()}>
              {save.isPending ? "Saving…" : changed ? "Save schools" : "No changes"}
            </button>
          )}
        </div>
      </div>
      <p className="card-subtitle season-intro">
        Families type their school's name, so one school arrives spelled several ways. Spellings that differ only in capitals,
        punctuation, “The”, “School” or “&amp;” are grouped automatically under the most common one. To group an abbreviation or
        nickname, type the school's name next to it (“SFS” → Sidwell Friends School); to split a wrong grouping, give the spelling its
        own name. Entries like “N/A” count as no school.
      </p>
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>As entered</th>
              <th className="num">Campers (all seasons)</th>
              <th>Grouped as</th>
              <th>Set school</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const explicit = s.entered in edits ? !!edits[s.entered]?.trim() : s.origin === "explicit";
              const others = s.school ? (groupSize.get(s.school) ?? 1) - 1 : 0;
              return (
                <tr key={s.entered}>
                  <td>{s.entered}</td>
                  <td className="num">{formatInt(s.campers)}</td>
                  <td>
                    {s.school ?? <span className="hint">Not a school</span>}
                    {others > 0 && <span className="hint"> · with {others} other spelling{others === 1 ? "" : "s"}</span>}
                  </td>
                  <td>
                    <input
                      type="text"
                      value={current(s.entered)}
                      placeholder={s.origin === "grouped" ? (s.school ?? "") : ""}
                      disabled={!canEdit}
                      aria-label={`School for ${s.entered}`}
                      onChange={(ev) => setSchool(s.entered, ev.target.value)}
                    />
                  </td>
                  <td>
                    {explicit ? (
                      <>
                        <span className="badge badge-explicit">Set here</span>{" "}
                        {canEdit && (
                          <button type="button" className="link-button" onClick={() => setSchool(s.entered, null)}>
                            Group automatically
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="badge">Automatic</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {data.spellings.length
                    ? "No schools match."
                    : "No schools yet. They appear once the Campminder report includes a School column (see Setup)."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
