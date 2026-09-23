import { BUSINESS_LINES } from "@dash/shared";
import { RevenueView } from "../components/RevenueView";

export function Overview() {
  return <RevenueView lines={[...BUSINESS_LINES]} title="Overview" />;
}
