import { Navigate, useParams } from "react-router-dom";
import { isRetailSource, isSource, SOURCE_INFO } from "@dash/shared";
import { RetailDetail } from "../components/RetailDetail";
import { RevenueView } from "../components/RevenueView";
import { SOURCE_COLOR_VAR } from "../lib/colors";

/** Advanced: everything from one platform, across all business lines. */
export function PlatformPage() {
  const { source = "" } = useParams();
  if (!isSource(source)) return <Navigate to="/advanced/status" replace />;
  const info = SOURCE_INFO[source];
  return (
    <RevenueView
      key={source}
      title={`${info.label} (all business lines)`}
      groupBy="source"
      groups={[{ key: source, label: info.label, color: SOURCE_COLOR_VAR[source] }]}
      freshnessSources={[source]}
      showBasis={!isRetailSource(source)}
    >
      {isRetailSource(source) ? (
        <RetailDetail source={source} />
      ) : (
        <p className="phase-note">{info.label} data arrives in phase {info.phase}.</p>
      )}
    </RevenueView>
  );
}
