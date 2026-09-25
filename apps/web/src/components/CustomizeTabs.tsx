import { useEffect, useRef, useState } from "react";
import { BUSINESS_LINE_INFO, BUSINESS_LINES, type BusinessLine } from "@dash/shared";
import { useSavePreferences } from "../lib/api";

interface Item {
  id: BusinessLine;
  shown: boolean;
}

/** Let each person pick which business-line tabs they see, and in what order. */
export function CustomizeTabs({ tabs, onClose }: { tabs: BusinessLine[]; onClose(): void }) {
  const [items, setItems] = useState<Item[]>(() => [
    ...tabs.map((id) => ({ id, shown: true })),
    ...BUSINESS_LINES.filter((id) => !tabs.includes(id)).map((id) => ({ id, shown: false })),
  ]);
  const save = useSavePreferences();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const move = (i: number, delta: number) =>
    setItems((list) => {
      const j = i + delta;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const submit = async () => {
    await save.mutateAsync({ tabs: items.filter((i) => i.shown).map((i) => i.id) });
    onClose();
  };

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="customize-title">
      <h2 id="customize-title">Your tabs</h2>
      <p className="muted">Choose which business lines appear in your menu and on your Overview, and their order. Only you see this.</p>
      <ul className="customize-list">
        {items.map((item, i) => (
          <li key={item.id}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={item.shown}
                onChange={(e) => setItems((list) => list.map((x) => (x.id === item.id ? { ...x, shown: e.target.checked } : x)))}
              />
              {BUSINESS_LINE_INFO[item.id].label}
            </label>
            <span className="customize-move">
              <button type="button" className="button button-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${BUSINESS_LINE_INFO[item.id].label} up`}>
                ↑
              </button>
              <button type="button" className="button button-ghost" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={`Move ${BUSINESS_LINE_INFO[item.id].label} down`}>
                ↓
              </button>
            </span>
          </li>
        ))}
      </ul>
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
      <div className="dialog-actions">
        <button type="button" className="button button-ghost" onClick={() => setItems(BUSINESS_LINES.map((id) => ({ id, shown: true })))}>
          Reset to default
        </button>
        <span className="spacer" />
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button button-primary" onClick={() => void submit()} disabled={save.isPending || !items.some((i) => i.shown)}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </dialog>
  );
}
