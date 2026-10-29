import { useState } from "react";
import type { ResolvedSchool, ResolvedSpelling, SchoolAction } from "@dash/shared";
import { useSchoolAction } from "../../lib/api";
import { formatInt } from "../../lib/format";
import { SchoolForm } from "./SchoolForm";
import { SchoolPicker, schoolMeta } from "./SchoolPicker";

const PAGE = 50;

/** Every school campers attend; open one to see the spellings matched to it. */
export function SchoolList({ schools, canEdit }: { schools: ResolvedSchool[]; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<"all" | "official" | "custom">("all");
  const [shown, setShown] = useState(PAGE);
  const term = q.trim().toLowerCase();
  const list = schools.filter(
    (s) =>
      (source === "all" || s.source === source) &&
      (!term || s.name.toLowerCase().includes(term) || s.spellings.some((x) => x.entered.toLowerCase().includes(term))),
  );
  return (
    <section className="table-card" aria-label="Schools">
      <div className="table-toolbar">
        <h2 className="table-title">
          Schools <span className="hint">({formatInt(schools.length)})</span>
        </h2>
        <div className="table-actions">
          <div className="segmented" role="tablist" aria-label="Which schools">
            {(
              [
                ["all", "All"],
                ["official", "Official"],
                ["custom", "Added here"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={source === id} onClick={() => setSource(id)}>
                {label}
              </button>
            ))}
          </div>
          <input type="search" placeholder="Search schools or spellings…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search schools" />
        </div>
      </div>
      <ul className="school-list">
        {list.slice(0, shown).map((s) => (
          <SchoolRow key={s.id} school={s} canEdit={canEdit} open={!!term && s.spellings.some((x) => x.entered.toLowerCase().includes(term))} />
        ))}
      </ul>
      {list.length === 0 && <p className="empty">{schools.length ? "No schools match." : "No schools yet."}</p>}
      {list.length > shown && (
        <div className="review-more">
          <button type="button" className="button" onClick={() => setShown((n) => n + PAGE)}>
            Show more ({formatInt(list.length - shown)} left)
          </button>
        </div>
      )}
    </section>
  );
}

function SchoolRow({ school, canEdit, open: openInitially }: { school: ResolvedSchool; canEdit: boolean; open: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"edit" | "merge" | null>(null);
  const act = useSchoolAction();
  const expanded = open || openInitially;
  const custom = school.source === "custom";
  const meta = schoolMeta(school);
  return (
    <li className="school-row">
      <button type="button" className="school-row-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <span className="school-row-caret" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="school-row-name">
          {school.name}
          <span className="hint">{[meta, custom ? "Added here" : null, school.source === "builtin" ? "Built in" : null].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="num">{formatInt(school.campers)} campers</span>
        <span className="hint num">
          {school.spellings.length} spelling{school.spellings.length === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && (
        <div className="school-row-body">
          {school.spellings.length > 0 ? (
            <table className="spelling-table">
              <thead>
                <tr>
                  <th>As entered</th>
                  <th className="num">Campers</th>
                  <th>Matched</th>
                  {canEdit && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {school.spellings.map((s) => (
                  <SpellingRow key={s.entered} spelling={s} canEdit={canEdit} />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">No spellings yet. Choose this school for a spelling in the review list.</p>
          )}
          {canEdit && custom && mode === null && (
            <div className="review-actions">
              <button type="button" className="button" onClick={() => setMode("edit")}>
                Edit details
              </button>
              <button type="button" className="button" onClick={() => setMode("merge")}>
                Merge into another school…
              </button>
            </div>
          )}
          {mode === "edit" && (
            <SchoolForm
              initial={{ name: school.name, type: school.type, state: school.state, county: school.county }}
              submitLabel="Save"
              busy={act.isPending}
              onCancel={() => setMode(null)}
              onSubmit={(s) => act.mutate({ action: "update", schoolId: school.id, school: s }, { onSuccess: () => setMode(null) })}
            />
          )}
          {mode === "merge" && (
            <SchoolPicker
              onCancel={() => setMode(null)}
              onPick={(t) => t.id !== school.id && act.mutate({ action: "merge", from: school.id, into: t.id }, { onSuccess: () => setMode(null) })}
            />
          )}
          {act.error && <div className="error-banner">Couldn't save: {act.error.message}</div>}
        </div>
      )}
    </li>
  );
}

function SpellingRow({ spelling, canEdit }: { spelling: ResolvedSpelling; canEdit: boolean }) {
  const [moving, setMoving] = useState(false);
  const act = useSchoolAction();
  const run = (a: SchoolAction) => act.mutate(a, { onSuccess: () => setMoving(false) });
  const spellings = [spelling.entered];
  return (
    <tr>
      <td>{spelling.entered}</td>
      <td className="num">{formatInt(spelling.campers)}</td>
      <td>
        {spelling.status === "confirmed" ? (
          <span className="badge badge-explicit">Confirmed</span>
        ) : (
          <span className="badge" title="Matched automatically">
            Auto {Math.round(spelling.confidence * 100)}%
          </span>
        )}
      </td>
      {canEdit && (
        <td className="spelling-actions">
          {moving ? (
            <SchoolPicker onCancel={() => setMoving(false)} onPick={(s) => run({ action: "assign", spellings, schoolId: s.id })} />
          ) : (
            <>
              <button type="button" className="link-button" onClick={() => setMoving(true)}>
                Move…
              </button>
              <button type="button" className="link-button" disabled={act.isPending} onClick={() => run({ action: "not-a-school", spellings })}>
                Not a school
              </button>
              {spelling.status === "confirmed" && (
                <button type="button" className="link-button" disabled={act.isPending} onClick={() => run({ action: "reset", spellings })}>
                  Match automatically
                </button>
              )}
            </>
          )}
          {act.error && <span className="error-text"> {act.error.message}</span>}
        </td>
      )}
    </tr>
  );
}
