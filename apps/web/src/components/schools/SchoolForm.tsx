import { useState } from "react";
import type { CustomSchool, SchoolType } from "@dash/shared";

/** Name, type and place of a school that isn't in the official directory. */
export function SchoolForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: Partial<CustomSchool>;
  submitLabel: string;
  busy: boolean;
  onSubmit: (s: CustomSchool) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [type, setType] = useState<SchoolType | "">(initial.type ?? "");
  const [state, setState] = useState(initial.state ?? "");
  const [county, setCounty] = useState(initial.county ?? "");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), type: type || null, state: state.trim() || null, county: county.trim() || null });
  };
  return (
    <form className="school-form" onSubmit={submit}>
      <label>
        <span>School name</span>
        <input type="text" value={name} required autoFocus maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span>Type</span>
        <select value={type} onChange={(e) => setType(e.target.value as SchoolType | "")}>
          <option value="">Not known</option>
          <option value="public">Public</option>
          <option value="private">Private</option>
          <option value="other">Other (preschool, abroad…)</option>
        </select>
      </label>
      <label>
        <span>State</span>
        <input type="text" value={state} maxLength={40} placeholder="MD, DC, VA…" onChange={(e) => setState(e.target.value)} />
      </label>
      <label>
        <span>County</span>
        <input type="text" value={county} maxLength={80} placeholder="Montgomery County" onChange={(e) => setCounty(e.target.value)} />
      </label>
      <div className="school-form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
