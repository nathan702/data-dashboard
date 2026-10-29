import { readFileSync } from "node:fs";
import type { OfficialSchool } from "@dash/shared";

/**
 * The official school directory (U.S. Department of Education, NCES) for the
 * area families come from, shipped with the API in data/official-schools.json
 * and refreshed with scripts/fetch-official-schools.ts. Empty until fetched:
 * schools are then matched among the spellings themselves.
 */
export function loadOfficialSchools(): OfficialSchool[] {
  try {
    const rows = JSON.parse(readFileSync(new URL("../data/official-schools.json", import.meta.url), "utf8")) as OfficialSchool[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
