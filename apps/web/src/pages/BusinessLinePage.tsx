import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { BUSINESS_LINE_INFO, isBusinessLine, isRetailSource, SOURCE_INFO, type BusinessLine, type Source } from "@dash/shared";
import { EnrollmentDetail } from "../components/EnrollmentDetail";
import { FreshnessNote } from "../components/Freshness";
import { RetailDetail } from "../components/RetailDetail";
import { RevenueView } from "../components/RevenueView";
import { SOURCE_COLOR_VAR } from "../lib/colors";

/** Platforms that have a connector today; others show when they arrive. */
const CONNECTED: Source[] = ["campminder", "shopify", "square"];
/** Connected platforms that carry money (Campminder has no financials yet). */
const REVENUE: Source[] = ["shopify", "square"];

function SourceSection({ line, source }: { line: BusinessLine; source: Source }) {
  const role = BUSINESS_LINE_INFO[line].sourceRoles[source];
  const title = `${role} · ${SOURCE_INFO[source].label}`;
  if (isRetailSource(source) && CONNECTED.includes(source)) {
    return <RetailDetail source={source} businessLine={line} title={title} />;
  }
  if (source === "campminder" && CONNECTED.includes(source)) {
    return <EnrollmentDetail businessLine={line} title={title} />;
  }
  return (
    <section className="page-section" aria-label={title}>
      <h2 className="section-title">{title}</h2>
      <div className="card placeholder-card">
        {SOURCE_INFO[source].label} data arrives in phase {SOURCE_INFO[source].phase}. Once connected, this section shows{" "}
        {role?.toLowerCase()} for {BUSINESS_LINE_INFO[line].label}.
      </div>
    </section>
  );
}

/** One business line: combined summary first, then a section per platform that feeds it. */
export function BusinessLinePage() {
  const { id = "" } = useParams();
  const { search } = useLocation();
  if (!isBusinessLine(id)) return <Navigate to={`/${search}`} replace />;
  const info = BUSINESS_LINE_INFO[id];
  const retailOnly = info.sources.every((s) => isRetailSource(s));
  const multi = info.sources.length > 1;
  const settingsNote = (
    <p className="phase-note">
      Which Square locations, sessions and pipelines count toward {info.label} is set on the{" "}
      <Link to="/advanced/settings">Settings</Link> page.
    </p>
  );
  // Nothing with dollars feeds this line yet: skip the (all-zero) revenue summary.
  if (!info.sources.some((s) => REVENUE.includes(s))) {
    return (
      <div className="page" key={id}>
        <header className="page-header">
          <h1>{info.label}</h1>
          <FreshnessNote sources={info.sources} />
        </header>
        <div className="page-body">
          {info.sources.map((s) => (
            <SourceSection key={s} line={id} source={s} />
          ))}
          {settingsNote}
        </div>
      </div>
    );
  }
  return (
    <RevenueView
      key={id}
      title={info.label}
      groupBy="business_line"
      groups={[{ key: id, label: info.label }]}
      freshnessSources={info.sources}
      showBasis={!retailOnly}
    >
      {multi && (
        <RevenueView
          title={`${info.label} by platform`}
          groupBy="source"
          businessLines={[id]}
          groups={info.sources.map((s) => ({ key: s, label: SOURCE_INFO[s].label, color: SOURCE_COLOR_VAR[s] }))}
          freshnessSources={[]}
          showBasis={!retailOnly}
          chart="groups"
          embedded
        />
      )}
      {info.sources.map((s) => (
        <SourceSection key={s} line={id} source={s} />
      ))}
      {settingsNote}
    </RevenueView>
  );
}
