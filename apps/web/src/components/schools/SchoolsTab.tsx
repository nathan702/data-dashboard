import { useState } from "react";
import type { ResolvedSpelling } from "@dash/shared";
import { useSchoolAction, useSchools } from "../../lib/api";
import { formatInt } from "../../lib/format";
import { ReviewList } from "./ReviewList";
import { SchoolList } from "./SchoolList";

/**
 * Settings → Schools: the review list (spellings the matcher wasn't sure
 * about) on top, then every school with the spellings matched to it, then
 * answers that aren't schools.
 */
export function SchoolsTab({ canEdit }: { canEdit: boolean }) {
  const { data, error, isLoading } = useSchools();
  if (error) return <div className="error-banner">Couldn't load schools: {error.message}</div>;
  if (isLoading || !data) return <p className="hint">Matching school spellings…</p>;

  const campers = (xs: Array<{ campers: number }>) => xs.reduce((t, x) => t + x.campers, 0);
  const matched = campers(data.schools);
  const reviewing = campers(data.review);
  const total = matched + reviewing;
  return (
    <>
      <p className="card-subtitle season-intro">
        Families type their school's name, so one school arrives spelled many ways. Each spelling is matched to an actual school: the
        official U.S. Department of Education list, or a school added here. Spellings it's at least 90% sure of are matched automatically;
        the rest wait below for a decision. Reports and the Camp pages use the result right away.
      </p>
      <div className="school-summary">
        <div className="card">
          <div className="hint">Schools</div>
          <strong>{formatInt(data.schools.length)}</strong>
        </div>
        <div className="card">
          <div className="hint">Campers matched to a school</div>
          <strong>{total ? `${Math.round((matched / total) * 100)}%` : "–"}</strong>
        </div>
        <div className="card">
          <div className="hint">Spellings to review</div>
          <strong>{formatInt(data.review.reduce((t, i) => t + i.spellings.length, 0))}</strong>
        </div>
      </div>
      {data.officialCount === 0 && (
        <div className="notice">
          The official school list isn't loaded yet, so spellings are only matched to schools added here and grouped with each other for
          review.
        </div>
      )}
      <ReviewList items={data.review} canEdit={canEdit} />
      <SchoolList schools={data.schools} canEdit={canEdit} />
      <NotSchools spellings={data.notSchools} canEdit={canEdit} />
    </>
  );
}

/** Answers that aren't schools: marked here (and kept out of the data), or saying none was given ("N/A"). */
function NotSchools({ spellings, canEdit }: { spellings: ResolvedSpelling[]; canEdit: boolean }) {
  const act = useSchoolAction();
  const [open, setOpen] = useState(false);
  if (!spellings.length) return null;
  return (
    <section className="table-card" aria-label="Not schools">
      <button type="button" className="school-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="school-row-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="school-row-name">
          <span>
            Not schools <span className="hint">({formatInt(spellings.length)})</span>
          </span>
          <span className="hint">
            Answers marked “not a school” are left out of the data from the next sync on. “N/A”, “TBD” and the like count as no school.
          </span>
        </span>
      </button>
      {open && (
        <table className="spelling-table">
          <tbody>
            {spellings.map((s) => (
              <tr key={s.entered}>
                <td>{s.entered}</td>
                <td className="num">{formatInt(s.campers)}</td>
                <td className="hint">{s.status === "not-a-school" ? "Marked not a school" : "No school given"}</td>
                <td className="spelling-actions">
                  {canEdit && s.status === "not-a-school" && (
                    <button type="button" className="link-button" disabled={act.isPending} onClick={() => act.mutate({ action: "reset", spellings: [s.entered] })}>
                      It's a school
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
