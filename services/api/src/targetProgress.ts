import {
  defaultTargetSeason,
  easternDate,
  lineCalendar,
  resolveHubspotRoles,
  samePointLastSeason,
  targetProgressRows,
  targetSeasons,
  type BusinessLine,
  type TargetProgressResponse,
} from "@dash/shared";
import type { SeasonSettingsStore } from "./seasons.js";
import type { TargetStore } from "./targets.js";
import type { Warehouse } from "./warehouse/types.js";

type Cached = <T extends object>(key: string, load: () => Promise<T>) => Promise<T>;
const noCache: Cached = (_key, load) => load();

/**
 * A line's progress against its targets for one season. The default season is
 * the one under way, or next season once this one's pace is complete (Camp in
 * the fall). Used by the line pages, the Overview, reports and the digests.
 */
export function createTargetProgress(deps: { warehouse: Warehouse; targets: TargetStore; seasons: SeasonSettingsStore; cached?: Cached }) {
  const cached = deps.cached ?? noCache;
  return async (businessLine: BusinessLine, requested?: number): Promise<TargetProgressResponse> => {
    const [targets, settings] = await Promise.all([deps.targets.get(), deps.seasons.get()]);
    const today = easternDate();
    const cal = lineCalendar(businessLine, settings);
    const seasons = targetSeasons(targets, businessLine);
    const progress = (season: number) => {
      const values = targets.seasons[String(season)]?.[businessLine] ?? {};
      const current = cal.range(season);
      const previous = cal.range(season - 1);
      const ended = today > current.end;
      // A finished season is compared with last season's full total; otherwise with last season by the same point.
      const asOf = ended ? current.end : today;
      const { cutoff, alignedBy } = samePointLastSeason(businessLine, season, asOf, settings.registration);
      const key = `targets:${businessLine}:${season}:${today}:${JSON.stringify(values)}:${JSON.stringify(current)}:${cutoff}:${JSON.stringify(settings.hubspot)}`;
      return cached(key, async (): Promise<TargetProgressResponse> => {
        const participantProps = values.participants === undefined ? [] : resolveHubspotRoles(settings.hubspot, await deps.warehouse.hubspotProperties()).participants;
        const actuals = await deps.warehouse.targetActuals({ businessLine, season, current, previous, cutoff, participantProps });
        return { businessLine, season, seasons, range: current, asOf, ended, samePoint: cutoff, alignedBy, rows: targetProgressRows(businessLine, values, actuals, ended) };
      });
    };
    const now = cal.seasonFor(today);
    const season = requested ?? defaultTargetSeason(seasons, now);
    if (season === null || !seasons.includes(season)) {
      return { businessLine, season: null, seasons, range: null, asOf: today, ended: false, samePoint: null, alignedBy: null, rows: [] };
    }
    const body = await progress(season);
    if (requested === undefined && season === now && seasons.includes(now + 1) && body.rows.every((r) => r.expected !== null && r.expected >= r.target)) {
      return progress(now + 1);
    }
    return body;
  };
}
