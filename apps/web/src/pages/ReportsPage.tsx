import { Link } from "react-router-dom";
import { REPORT_DATASET_INFO } from "@dash/shared";
import { useMe, useReports, type ReportListItem } from "../lib/api";
import { formatDate } from "../lib/format";

function ReportCard({ r, me }: { r: ReportListItem; me: string | undefined }) {
  const mine = r.owner?.toLowerCase() === me?.toLowerCase();
  return (
    <Link to={`/reports/${r.id}`} className="card report-card tile-link">
      <div className="report-card-head">
        <strong>{r.name}</strong>
        {r.starter ? <span className="badge">Starter</span> : r.shared ? <span className="badge">Shared</span> : <span className="badge">Private</span>}
      </div>
      {r.description && <p className="card-subtitle">{r.description}</p>}
      <p className="hint">
        {REPORT_DATASET_INFO[r.spec.dataset].label}
        {!r.starter && r.owner && ` · ${mine ? "you" : r.owner}`}
        {r.updatedAt && ` · updated ${formatDate(r.updatedAt.slice(0, 10))}`}
      </p>
    </Link>
  );
}

/** Every report the viewer can open: starter reports, shared ones, and their own. */
export function ReportsPage() {
  const { data, error } = useReports();
  const me = useMe().data?.email;
  const all = data?.reports ?? [];
  const groups: Array<[string, ReportListItem[]]> = [
    ["Your reports", all.filter((r) => !r.starter && r.owner?.toLowerCase() === me?.toLowerCase())],
    ["Shared with everyone", all.filter((r) => !r.starter && r.shared && r.owner?.toLowerCase() !== me?.toLowerCase())],
    ["Starter reports", all.filter((r) => r.starter)],
  ];
  return (
    <div className="page">
      <header className="page-header">
        <h1>Reports</h1>
        <Link to="/reports/new" className="button button-primary">
          + New report
        </Link>
      </header>
      <p className="card-subtitle">
        Build your own tables and charts from camp enrollments, campers, revenue and store sales. Save them privately or share them with
        everyone; open a starter report and “Save a copy” to adapt it.
      </p>
      {error && <div className="error-banner">Couldn't load reports: {error.message}</div>}
      {groups.map(([title, list]) =>
        list.length ? (
          <section key={title} className="page-section" aria-label={title}>
            <h2 className="section-title">{title}</h2>
            <div className="report-grid">
              {list.map((r) => (
                <ReportCard key={r.id} r={r} me={me} />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}
