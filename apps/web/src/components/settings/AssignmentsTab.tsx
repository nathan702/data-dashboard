import { useMemo, useState } from "react";
import {
  ASSIGNMENT_KINDS,
  BUSINESS_LINE_INFO,
  BUSINESS_LINES,
  businessLineLabel,
  UNASSIGNED,
  type AssignmentRow,
  type BusinessLineOrUnassigned,
  type Source,
} from "@dash/shared";
import { DataTable, type Column } from "../DataTable";
import { useAssignments, useSaveAssignments } from "../../lib/api";
import { formatDate, formatInt, formatUsd } from "../../lib/format";

export const rowId = (r: Pick<AssignmentRow, "source" | "kind" | "key">) => `${r.source}|${r.kind}|${r.key}`;

const ORIGIN_LABEL: Record<AssignmentRow["origin"], string> = {
  explicit: "Set here",
  default: "Default",
  none: "Not assigned",
};

/** Campminder groups count from any season, so past seasons' groups get assigned too. */
export const isActive = (r: AssignmentRow) =>
  r.source === "campminder" ? !!r.lastActivity : r.netLast12Months !== 0 || r.activityLast12Months !== 0;

/** Which business line each of one platform's locations, sessions… counts toward. */
export function AssignmentsTab({ source }: { source: Source }) {
  const { data, error } = useAssignments();
  const save = useSaveAssignments();
  const [edits, setEdits] = useState<Record<string, BusinessLineOrUnassigned>>({});
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const canEdit = data?.canEdit ?? false;

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => r.source === source), [data, source]);
  const changed = rows.filter((r) => edits[rowId(r)] !== undefined && edits[rowId(r)] !== r.businessLine);
  const unassigned = rows.filter((r) => (edits[rowId(r)] ?? r.businessLine) === UNASSIGNED && isActive(r));
  const kind = ASSIGNMENT_KINDS[source].label.toLowerCase();

  const submit = async () => {
    await save.mutateAsync({
      changes: changed.map((r) => ({ source: r.source, kind: r.kind, key: r.key, businessLine: edits[rowId(r)]! })),
    });
    setEdits({});
    setSavedMessage(`Saved ${changed.length} change${changed.length === 1 ? "" : "s"}. Dashboards update in about 3 minutes.`);
  };

  const columns: Column<AssignmentRow>[] = [
    { key: "label", label: "Name", value: (r) => r.label },
    { key: "lastActivity", label: "Last activity", value: (r) => r.lastActivity, render: (r) => (r.lastActivity ? formatDate(r.lastActivity) : "–") },
    {
      key: "activity",
      label: "Last 12 months",
      numeric: true,
      // Campminder has no money yet, so its sessions show enrollments.
      value: (r) => (r.source === "campminder" ? r.activityLast12Months : r.netLast12Months),
      render: (r) => (r.source === "campminder" ? `${formatInt(r.activityLast12Months)} enrolled` : formatUsd(r.netLast12Months)),
    },
    {
      key: "businessLine",
      label: "Counts toward",
      value: (r) => businessLineLabel(edits[rowId(r)] ?? r.businessLine),
      render: (r) => {
        const value = edits[rowId(r)] ?? r.businessLine;
        return (
          <select
            aria-label={`Business line for ${r.label}`}
            value={value}
            disabled={!canEdit}
            className={value === UNASSIGNED ? "select-warning" : undefined}
            onChange={(e) => {
              setSavedMessage(null);
              setEdits((x) => ({ ...x, [rowId(r)]: e.target.value as BusinessLineOrUnassigned }));
            }}
          >
            {BUSINESS_LINES.map((id) => (
              <option key={id} value={id}>
                {BUSINESS_LINE_INFO[id].label}
              </option>
            ))}
            <option value={UNASSIGNED}>Unassigned</option>
          </select>
        );
      },
    },
    {
      key: "origin",
      label: "Status",
      value: (r) => (edits[rowId(r)] !== undefined && edits[rowId(r)] !== r.businessLine ? "Unsaved" : ORIGIN_LABEL[r.origin]),
      render: (r) =>
        edits[rowId(r)] !== undefined && edits[rowId(r)] !== r.businessLine ? (
          <span className="badge badge-pending">Unsaved</span>
        ) : (
          <span className={`badge badge-${r.origin}`}>{ORIGIN_LABEL[r.origin]}</span>
        ),
    },
  ];

  return (
    <>
      <p className="card-subtitle season-intro">
        Which business line each {kind} counts toward. Anything new starts as “Unassigned” until it's set here.
      </p>
      {unassigned.length > 0 && (
        <div className="notice notice-warning">
          <strong>▲ {unassigned.length} with recent activity {unassigned.length === 1 ? "isn't" : "aren't"} assigned</strong> to a business line, so{" "}
          {unassigned.length === 1 ? "it shows" : "they show"} as “Unassigned” on the Overview.
        </div>
      )}
      {data?.pendingRefresh && !savedMessage && <div className="notice">Recent changes are still being applied; dashboards update within a few minutes.</div>}
      {savedMessage && <div className="notice notice-good">✓ {savedMessage}</div>}
      {error && <div className="error-banner">Couldn't load settings: {error.message}</div>}
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
      {data && (
        <DataTable
          caption={ASSIGNMENT_KINDS[source].label}
          rows={rows}
          columns={columns}
          rowKey={rowId}
          exportName={`${source}_business_lines`}
          actions={
            canEdit && (
              <>
                {changed.length > 0 && (
                  <button type="button" className="button" onClick={() => setEdits({})}>
                    Discard
                  </button>
                )}
                <button type="button" className="button button-primary" disabled={changed.length === 0 || save.isPending} onClick={() => void submit()}>
                  {save.isPending ? "Saving…" : changed.length ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}` : "No changes"}
                </button>
              </>
            )
          }
        />
      )}
    </>
  );
}
