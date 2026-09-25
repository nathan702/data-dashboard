import { z } from "zod";
import { BUSINESS_LINES, type BusinessLine } from "./businessLines.js";

/** Per-person tab setup, saved to their account so it follows them between devices. */
export interface Preferences {
  /** Tabs to show, in order. Business lines left out are hidden. */
  tabs: BusinessLine[];
}

export const DEFAULT_PREFERENCES: Preferences = { tabs: [...BUSINESS_LINES] };

export const preferencesSchema = z.object({
  tabs: z
    .array(z.enum(BUSINESS_LINES))
    .max(BUSINESS_LINES.length)
    .refine((t) => new Set(t).size === t.length, "Duplicate tab"),
});

/** Drop unknown or duplicate ids from stored preferences (e.g. after a line is renamed). */
export function cleanPreferences(raw: unknown): Preferences {
  const tabs = Array.isArray((raw as Preferences | null)?.tabs) ? (raw as Preferences).tabs : null;
  if (!tabs) return DEFAULT_PREFERENCES;
  const seen = new Set<string>();
  const clean = tabs.filter((t) => (BUSINESS_LINES as readonly string[]).includes(t) && !seen.has(t) && seen.add(t));
  return { tabs: clean as BusinessLine[] };
}
