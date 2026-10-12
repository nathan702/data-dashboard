import { useState } from "react";
import { draftProgramFamily, type ProgramFamilySettings } from "@dash/shared";
import { useProgramFamilies, useSaveProgramFamilies } from "../lib/api";
import { formatInt } from "../lib/format";

type Edit = { family: string; branch: string };

/**
 * Which family and branch each Campminder program belongs to (Explorers →
 * Critters and Creatures / Quest / Great Heights), for reports. Drafted from
 * the program name ("Explorers - Quest"); admins confirm or correct.
 */
export function ProgramFamiliesCard({ canEdit }: { canEdit: boolean }) {
  const { data, error } = useProgramFamilies();
  const save = useSaveProgramFamilies();
  const [edits, setEdits] = useState<Record<string, Edit | null>>({});
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState("");
  if (error) return <div className="error-banner">Couldn't load program families: {error.message}</div>;
  if (!data) return null;

  const current = (program: string): Edit => {
    if (program in edits) {
      const e = edits[program];
      if (e) return e;
      const d = draftProgramFamily(program);
      return { family: d.family, branch: d.branch ?? "" };
    }
    const row = data.programs.find((p) => p.program === program)!;
    return { family: row.family, branch: row.branch ?? "" };
  };
  const changed = Object.keys(edits).length > 0;
  // Each family's programs together (A–Z by family, then program); search matches program or family.
  const q = query.trim().toLowerCase();
  const shown = data.programs
    .filter((p) => !q || p.program.toLowerCase().includes(q) || current(p.program).family.toLowerCase().includes(q))
    // Sorted by the saved family, so a row doesn't jump while its family is being typed.
    .sort((a, b) => a.family.localeCompare(b.family) || a.program.localeCompare(b.program));
  const submit = async () => {
    const overrides: ProgramFamilySettings["overrides"] = { ...data.overrides };
    for (const [program, e] of Object.entries(edits)) {
      if (e === null) delete overrides[program];
      else overrides[program] = { family: e.family.trim() || program, branch: e.branch.trim() || null };
    }
    await save.mutateAsync({ overrides });
    setEdits({});
    setSaved(true);
  };
  const setField = (program: string, key: keyof Edit, value: string) => {
    setSaved(false);
    setEdits((all) => ({ ...all, [program]: { ...current(program), [key]: value } }));
  };

  return (
    <section className="table-card" aria-label="Program families">
      <div className="table-toolbar">
        <h2 className="table-title">Program families</h2>
        <div className="table-actions">
          <input type="search" placeholder="Search programs or families…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search programs" />
          {saved && !changed && <span className="hint">✓ Saved. Reports use it right away.</span>}
          {canEdit && changed && (
            <button type="button" className="button" onClick={() => setEdits({})}>
              Discard
            </button>
          )}
          {canEdit && (
            <button type="button" className="button button-primary" disabled={!changed || save.isPending} onClick={() => void submit()}>
              {save.isPending ? "Saving…" : changed ? "Save program families" : "No changes"}
            </button>
          )}
        </div>
      </div>
      <p className="card-subtitle season-intro">
        Reports group programs into families and branches (e.g. Explorers → Critters and Creatures, Quest, Great Heights). They're drafted
        from the name: “Explorers - Quest” becomes family Explorers, branch Quest. Correct any that are wrong; leave branch empty for a
        program with no branches.
      </p>
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Program</th>
              <th className="num">Enrolled (all seasons)</th>
              <th>Family</th>
              <th>Branch</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const e = current(p.program);
              const explicit = p.program in edits ? edits[p.program] !== null : p.origin === "explicit";
              return (
                <tr key={p.program}>
                  <td>{p.program}</td>
                  <td className="num">{formatInt(p.enrollments)}</td>
                  <td>
                    <input type="text" value={e.family} disabled={!canEdit} aria-label={`${p.program} family`} onChange={(ev) => setField(p.program, "family", ev.target.value)} />
                  </td>
                  <td>
                    <input type="text" value={e.branch} disabled={!canEdit} aria-label={`${p.program} branch`} onChange={(ev) => setField(p.program, "branch", ev.target.value)} />
                  </td>
                  <td>
                    {explicit ? (
                      <>
                        <span className="badge badge-explicit">Set here</span>{" "}
                        {canEdit && (
                          <button type="button" className="link-button" onClick={() => setEdits((all) => ({ ...all, [p.program]: null }))}>
                            Use draft
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="badge">Draft</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {data.programs.length ? "No programs match." : "No Campminder programs yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
