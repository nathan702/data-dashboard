import { useState } from "react";
import type { SchoolAction, SchoolReviewItem } from "@dash/shared";
import { useSchoolAction } from "../../lib/api";
import { formatInt } from "../../lib/format";
import { SchoolForm } from "./SchoolForm";
import { SchoolPicker } from "./SchoolPicker";

const PAGE = 20;

const REASON: Record<SchoolReviewItem["reason"], string> = {
  exact: "Same name",
  words: "Close match",
  acronym: "Matches its initials",
  ambiguous: "Could be more than one school",
  multi: "The answer names two schools",
  none: "Not in the school list",
  new: "Not in the school list",
};

/** Spellings the matcher wasn't sure about, grouped with their look-alikes, most campers first. */
export function ReviewList({ items, canEdit }: { items: SchoolReviewItem[]; canEdit: boolean }) {
  const [shown, setShown] = useState(PAGE);
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const list = term ? items.filter((i) => i.spellings.some((s) => s.entered.toLowerCase().includes(term))) : items;
  return (
    <section className="table-card" aria-label="Needs review">
      <div className="table-toolbar">
        <h2 className="table-title">
          Needs review <span className="hint">({formatInt(items.length)})</span>
        </h2>
        <div className="table-actions">
          <input type="search" placeholder="Search spellings…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search review list" />
        </div>
      </div>
      <p className="card-subtitle season-intro">
        Spellings the matcher wasn't sure about, grouped with ones that look alike. Until they're settled, reports show them under the most
        common spelling. Untick a spelling to leave it for later.
      </p>
      {list.length === 0 && <p className="empty">{items.length ? "No spellings match." : "Nothing to review: every spelling is matched to a school."}</p>}
      <ul className="review-list">
        {list.slice(0, shown).map((item) => (
          <ReviewRow key={item.key} item={item} canEdit={canEdit} />
        ))}
      </ul>
      {list.length > shown && (
        <div className="review-more">
          <button type="button" className="button" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, list.length - shown)} more of {formatInt(list.length - shown)}
          </button>
        </div>
      )}
    </section>
  );
}

function ReviewRow({ item, canEdit }: { item: SchoolReviewItem; canEdit: boolean }) {
  const act = useSchoolAction();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(item.spellings.map((s) => s.entered)));
  const [mode, setMode] = useState<"choose" | "create" | null>(null);
  const spellings = item.spellings.filter((s) => picked.has(s.entered)).map((s) => s.entered);
  const run = (a: SchoolAction) => act.mutate(a, { onSuccess: () => setMode(null) });
  const toggle = (entered: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(entered)) next.delete(entered);
      else next.add(entered);
      return next;
    });

  return (
    <li className="review-item">
      <div className="review-head">
        <strong>{item.name}</strong>
        <span className="hint">
          {formatInt(item.campers)} camper{item.campers === 1 ? "" : "s"}
          {item.spellings.length > 1 && ` · ${item.spellings.length} spellings`}
        </span>
      </div>
      {item.spellings.length > 1 && (
        <div className="chips review-spellings">
          {item.spellings.map((s) =>
            canEdit ? (
              <label key={s.entered} className="chip review-chip">
                <input type="checkbox" checked={picked.has(s.entered)} onChange={() => toggle(s.entered)} />
                {s.entered} <span className="hint">{s.campers}</span>
              </label>
            ) : (
              <span key={s.entered} className="chip">
                {s.entered} <span className="hint">{s.campers}</span>
              </span>
            ),
          )}
        </div>
      )}
      <p className="review-suggestion">
        {item.suggestion ? (
          <>
            Looks like <strong>{item.suggestion.name}</strong>{" "}
            <span className="hint">
              ({Math.round(item.suggestion.confidence * 100)}% · {REASON[item.reason]}
              {item.alternatives.length > 0 && `; also could be ${item.alternatives.map((a) => a.name).join(" or ")}`})
            </span>
          </>
        ) : (
          <span className="hint">{REASON[item.reason]}</span>
        )}
      </p>
      {canEdit && mode === null && (
        <div className="review-actions">
          {item.suggestion && (
            <button
              type="button"
              className="button button-primary"
              disabled={!spellings.length || act.isPending}
              onClick={() => run({ action: "assign", spellings, schoolId: item.suggestion!.id })}
            >
              Accept
            </button>
          )}
          <button type="button" className="button" disabled={!spellings.length} onClick={() => setMode("choose")}>
            Choose a school…
          </button>
          <button type="button" className="button" disabled={!spellings.length} onClick={() => setMode("create")}>
            New school
          </button>
          <button type="button" className="button button-ghost" disabled={!spellings.length || act.isPending} onClick={() => run({ action: "not-a-school", spellings })}>
            Not a school
          </button>
          {spellings.length < item.spellings.length && (
            <span className="hint">
              {spellings.length} of {item.spellings.length} spellings
            </span>
          )}
        </div>
      )}
      {mode === "choose" && <SchoolPicker onCancel={() => setMode(null)} onPick={(s) => run({ action: "assign", spellings, schoolId: s.id })} />}
      {mode === "create" && (
        <SchoolForm
          initial={{ name: item.name }}
          submitLabel="Add school"
          busy={act.isPending}
          onCancel={() => setMode(null)}
          onSubmit={(school) => run({ action: "create", spellings, school })}
        />
      )}
      {act.error && <div className="error-banner">Couldn't save: {act.error.message}</div>}
    </li>
  );
}
