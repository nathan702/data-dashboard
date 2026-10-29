import { useState } from "react";
import { useSchoolSearch, type SchoolSearchResult } from "../../lib/api";

const TYPE_LABEL: Record<string, string> = { public: "Public", private: "Private", other: "Other" };

/** Where a school is and what kind, in one short line ("Bethesda, MD · Public"). */
export function schoolMeta(s: { city?: string | null; county?: string | null; state?: string | null; type?: string | null }) {
  const place = [s.city ?? s.county, s.state].filter(Boolean).join(", ");
  return [place, s.type ? TYPE_LABEL[s.type] : null].filter(Boolean).join(" · ");
}

/** Type a few letters of a school, pick it from the official directory or the schools added here. */
export function SchoolPicker({ onPick, onCancel, autoFocus = true }: { onPick: (s: SchoolSearchResult) => void; onCancel: () => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const { data, isFetching } = useSchoolSearch(q);
  const results = q.trim().length >= 2 ? (data?.results ?? []) : [];
  return (
    <div className="school-picker">
      <div className="school-picker-input">
        <input
          type="search"
          value={q}
          autoFocus={autoFocus}
          placeholder="Type a school's name…"
          aria-label="Search schools"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
        />
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {q.trim().length >= 2 && (
        <ul className="school-picker-results" role="listbox" aria-label="Matching schools">
          {results.map((s) => (
            <li key={s.id}>
              <button type="button" role="option" aria-selected={false} onClick={() => onPick(s)}>
                <span>{s.name}</span>
                <span className="hint">{schoolMeta(s)}</span>
              </button>
            </li>
          ))}
          {!results.length && <li className="hint school-picker-empty">{isFetching ? "Searching…" : "No school by that name. Use “New school” to add it."}</li>}
        </ul>
      )}
    </div>
  );
}
