import { cleanPreferences, DEFAULT_PREFERENCES, type BusinessLine } from "@dash/shared";
import { usePreferences } from "./api";

/** This person's business-line tabs, in their chosen order (default order until loaded). */
export function useTabs(): BusinessLine[] {
  const { data } = usePreferences();
  return (data ? cleanPreferences(data) : DEFAULT_PREFERENCES).tabs;
}
