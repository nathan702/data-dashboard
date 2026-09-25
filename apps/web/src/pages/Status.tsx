import { SOURCE_INFO, type SourceFreshness } from "@dash/shared";
import { DataTable } from "../components/DataTable";
import { health, HealthBadge, useNow } from "../components/Freshness";
import { useFreshness } from "../lib/api";
import { timeAgo } from "../lib/format";

export function Status() {
  const { data, error } = useFreshness();
  const now = useNow();
  return (
    <div className="page">
      <header className="page-header">
        <h1>Data status</h1>
        <p className="freshness-note">When each source last delivered data. Refreshes every 30 seconds.</p>
      </header>
      {error && <div className="error-banner">Couldn't load status: {error.message}</div>}
      {data && (
        <DataTable<SourceFreshness>
          rows={data.sources}
          rowKey={(r) => r.source}
          exportName="data_status"
          searchable={false}
          columns={[
            { key: "source", label: "Source", value: (r) => SOURCE_INFO[r.source].label },
            { key: "health", label: "Health", value: (r) => health(r, now), render: (r) => <HealthBadge h={health(r, now)} /> },
            { key: "method", label: "How it syncs", value: (r) => SOURCE_INFO[r.source].ingestion },
            { key: "lastData", label: "Last new data", value: (r) => r.lastDataAt, render: (r) => timeAgo(r.lastDataAt, now) },
            { key: "lastSuccess", label: "Last full sync", value: (r) => r.lastSuccessAt, render: (r) => timeAgo(r.lastSuccessAt, now) },
            { key: "error", label: "Last error", value: (r) => r.lastError, render: (r) => r.lastError ?? "–" },
          ]}
        />
      )}
    </div>
  );
}
