import {
  ageOutAfter,
  campminderCalendar,
  defaultReturningSeason,
  resolveReturning,
  returningSummary,
  type IsoDate,
  type ReturningFamily,
  type ReturningResponse,
  type ReturningSummary,
  type SeasonSettings,
} from "@dash/shared";
import type { SeasonSettingsStore } from "./seasons.js";
import type { Warehouse } from "./warehouse/types.js";

export interface ReturningDeps {
  warehouse: Warehouse;
  seasons: SeasonSettingsStore;
  /** Caches the warehouse rows (the API's cache); called with a key that changes with the settings used. */
  cache?: <T extends object>(key: string, load: () => Promise<T>) => Promise<T>;
}

/** Every season's returning families with the rules applied, and the settings they were worked out with. */
export async function allReturningFamilies(deps: ReturningDeps): Promise<{ families: ReturningFamily[]; settings: SeasonSettings }> {
  const settings = await deps.seasons.get();
  const { locations } = settings.registration;
  const load = () => deps.warehouse.returningFamilies(locations, []).then((rows) => ({ rows }));
  const { rows } = deps.cache ? await deps.cache(`returning:${JSON.stringify(locations)}`, load) : await load();
  return { families: resolveReturning(rows, settings.registration), settings };
}

/** The Camp page's returning families card: one season and the two before it. */
export async function returningResponse(deps: ReturningDeps, requested: number | undefined, today: IsoDate): Promise<ReturningResponse> {
  const { families, settings } = await allReturningFamilies(deps);
  const seasons = [...new Set(families.map((f) => f.season))].sort((a, b) => b - a);
  const current = campminderCalendar(settings.campminderStarts).seasonFor(today);
  const season = requested !== undefined && seasons.includes(requested) ? requested : defaultReturningSeason(seasons, current);
  const shown = season === undefined ? [] : [season, season - 1, season - 2];
  return {
    season: season ?? current,
    seasons,
    asOf: { today, over: season !== undefined && current > season },
    families: families.filter((f) => shown.includes(f.season)),
    ageOutAfter: Object.fromEntries(shown.map((s) => [String(s), ageOutAfter(families.filter((f) => f.season === s), settings.registration.ageOutAfter)])),
    ageOutSet: settings.registration.ageOutAfter !== null,
    opens: Object.fromEntries(shown.filter((s) => settings.registration.opens[String(s)]).map((s) => [String(s), settings.registration.opens[String(s)]!])),
  };
}

/**
 * For the digests: the season whose registration is under way, once it has
 * opened (or someone has re-enrolled) and until its summer ends; else null.
 */
export async function returningForDigest(deps: ReturningDeps, today: IsoDate): Promise<ReturningSummary | null> {
  const { families, settings } = await allReturningFamilies(deps);
  const season = campminderCalendar(settings.campminderStarts).seasonFor(today);
  const cur = families.filter((f) => f.season === season);
  if (!cur.length) return null;
  const opens = Object.values(settings.registration.opens[String(season)] ?? {}).filter(Boolean).sort();
  const opened = opens.length ? opens[0]! <= today : cur.some((f) => f.status === "enrolled");
  if (!opened) return null;
  return returningSummary(families, season, settings.registration, { today, over: false });
}
