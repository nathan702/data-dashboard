import { useMemo, useState } from "react";
import {
  ASSIGNMENT_KINDS,
  BUSINESS_LINE_INFO,
  BUSINESS_LINES,
  businessLineLabel,
  SOURCE_INFO,
  UNASSIGNED,
  type AssignmentRow,
  type BusinessLineOrUnassigned,
} from "@dash/shared";
import { DataTable, type Column } from "../components/DataTable";
import { useAssignments, useMe, useSaveAssignments } from "../lib/api";
import { formatDate, formatUsd } from "../lib/format";

const rowId = (r: Pick<AssignmentRow, "source" | "kind" | "key">) => `${r.source}|${r.kind}|${r.key}`;

const ORIGIN_LABEL: Record<AssignmentRow["origin"], string> = {
  explicit: "Set here",
  default: "Default",
  none: "Not assigned",
};

/** Admins decide which business line each Square location (and later session, pipeline…) counts toward. */
export function SettingsPage() {
  const { data, error } = useAssignments();
  const me = useMe();
  const save = useSaveAssignments();
  const [edits, setEdits] = useState<Record<string, BusinessLineOrUnassigned>>({});
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const canEdit = data?.canEdit ?? false;

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const changed = rows.filter((r) => edits[rowId(r)] !== undefined && edits[rowId(r)] !== r.businessLine);
  const unassigned = rows.filter((r) => (edits[rowId(r)] ?? r.businessLine) === UNASSIGNED && r.netLast12Months !== 0);

  const submit = async () => {
    await save.mutateAsync({
      changes: changed.map((r) => ({ source: r.source, kind: r.kind, key: r.key, businessLine: edits[rowId(r)]! })),
    });
    setEdits({});
    setSavedMessage(`Saved ${changed.length} change${changed.length === 1 ? "" : "s"}. Dashboards update in about 3 minutes.`);
  };

  const columns: Column<AssignmentRow>[] = [
    { key: "source", label: "Platform", value: (r) => SOURCE_INFO[r.source].label },
    { key: "kind", label: "Type", value: (r) => ASSIGNMENT_KINDS[r.source].label },
    { key: "label", label: "Name", value: (r) => r.label },
    { key: "lastActivity", label: "Last sale", value: (r) => r.lastActivity, render: (r) => (r.lastActivity ? formatDate(r.lastActivity) : "–") },
    { key: "net", label: "Net sales, last 12 months", numeric: true, value: (r) => r.netLast12Months, render: (r) => formatUsd(r.netLast12Months) },
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
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
        <p className="freshness-note">Which business line each location, store, session or pipeline counts toward.</p>
      </header>
      {me.data?.adminsUnconfigured && (
        <div className="notice">
          Everyone who can sign in can change these settings, because no admins are listed yet. To limit it, add an <code>admins</code> list
          to the <code>config/access</code> document in Firestore (see docs/SETUP.md).
        </div>
      )}
      {!canEdit && data && <div className="notice">Only dashboard admins can change these. Ask an admin if something is assigned to the wrong place.</div>}
      {unassigned.length > 0 && (
        <div className="notice notice-warning">
          <strong>▲ {unassigned.length} with recent sales {unassigned.length === 1 ? "isn't" : "aren't"} assigned</strong> to a business line, so{" "}
          {unassigned.length === 1 ? "it shows" : "they show"} as “Unassigned” on the Overview.
        </div>
      )}
      {data?.pendingRefresh && !savedMessage && <div className="notice">Recent changes are still being applied; dashboards update within a few minutes.</div>}
      {savedMessage && <div className="notice notice-good">✓ {savedMessage}</div>}
      {error && <div className="error-banner">Couldn't load settings: {error.message}</div>}
      {save.error && <div className="error-banner">Couldn't save: {save.error.message}</div>}
      {data && (
        <DataTable
          caption="Assignments"
          rows={rows}
          columns={columns}
          rowKey={rowId}
          exportName="business_line_assignments"
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
      <p className="phase-note">
        FareHarbor dashboards, Campminder sessions and HubSpot pipelines appear here as each platform is connected. Anything new starts as
        “Unassigned” until it's set here.
      </p>
    </div>
  );
}
