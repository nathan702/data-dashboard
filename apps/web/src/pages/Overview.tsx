import { useLocation } from "react-router-dom";
import { BUSINESS_LINE_INFO, SOURCES, UNASSIGNED, UNASSIGNED_LABEL } from "@dash/shared";
import { RevenueView, type GroupDef } from "../components/RevenueView";
import { useTabs } from "../lib/tabs";

/** Every business line (in this person's tab order), plus anything not yet assigned. */
export function Overview() {
  const tabs = useTabs();
  const { search } = useLocation();
  const groups: GroupDef[] = [
    ...tabs.map((id) => ({ key: id, label: BUSINESS_LINE_INFO[id].label, href: `/bl/${id}${search}` })),
    { key: UNASSIGNED, label: UNASSIGNED_LABEL, href: `/advanced/settings` },
  ];
  return (
    <RevenueView
      title="Overview"
      groupBy="business_line"
      groups={groups}
      freshnessSources={[...SOURCES]}
      chart="total"
      rankGroups
      showTable
      hideEmptyGroups={[UNASSIGNED]}
    />
  );
}
