import { Navigate, useParams } from "react-router-dom";
import { BUSINESS_LINE_INFO, isBusinessLine, isRetailLine } from "@dash/shared";
import { RetailDetail } from "../components/RetailDetail";
import { RevenueView } from "../components/RevenueView";

export function BusinessLinePage() {
  const { line = "" } = useParams();
  if (!isBusinessLine(line)) return <Navigate to="/" replace />;
  const info = BUSINESS_LINE_INFO[line];
  return (
    <>
      <RevenueView key={line} lines={[line]} title={info.label} />
      {isRetailLine(line) ? (
        <RetailDetail key={`${line}-detail`} line={line} />
      ) : (
        <p className="phase-note">
          Detailed {info.label} dashboards arrive in phase {info.phase}. See the Status page for connection progress.
        </p>
      )}
    </>
  );
}
