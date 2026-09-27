import type { Firestore } from "@google-cloud/firestore";
import { pseudonymize } from "../core/privacy.js";

/**
 * Home locations for the family map. Addresses are turned into coordinates
 * here and never stored: results are cached under a keyed hash of the
 * address, and only latitude/longitude reach BigQuery.
 */

export interface HomeAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export type LatLon = { lat: number; lon: number };
/** null = the geocoder found no match (cached, so it isn't asked again). */
export type GeoResult = LatLon | null;

export interface Geocoder {
  /** Coordinates per id; ids missing from the result weren't answered (retry later). */
  batch(addresses: Array<{ id: string } & HomeAddress>): Promise<Map<string, GeoResult>>;
}

export interface GeoCache {
  get(keys: string[]): Promise<Map<string, GeoResult>>;
  set(entries: Map<string, GeoResult>): Promise<void>;
}

const clean = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

/** The report's home address, or null when there isn't enough to place it. */
export function homeAddress(r: Record<string, string>): HomeAddress | null {
  const street = clean(r["Primary Childhood HomeAddr1"]);
  const city = clean(r["Primary Childhood HomeCity"]);
  const state = clean(r["Primary Childhood HomeState"]);
  const zip = zip5(r["Primary Childhood HomeZip"]) ?? "";
  if (!street || !(zip || (city && state))) return null;
  return { street, city, state, zip };
}

export function zip5(v: string | undefined): string | null {
  const m = /^\s*(\d{5})/.exec(v ?? "");
  return m ? m[1]! : null;
}

export function addressKey(a: HomeAddress, key: string): string {
  return pseudonymize(`addr|${a.street}|${a.city}|${a.state}|${a.zip}`, key)!;
}

/** About a metre; plenty for a map. */
const round = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Coordinates for every address in the report: cached ones first, the rest
 * from the geocoder (while there's time), then cached for next time. A
 * geocoder outage leaves those homes off the map until a later run
 * (`complete` is false, so the caller knows to come back).
 */
export async function locateHomes(
  addresses: HomeAddress[],
  key: string,
  deps: { cache: GeoCache; geocoder: Geocoder; outOfTime(): boolean; log(message: string, fields?: Record<string, unknown>): void },
): Promise<{ homes: Map<string, GeoResult>; complete: boolean }> {
  const byKey = new Map<string, HomeAddress>();
  for (const a of addresses) byKey.set(addressKey(a, key), a);
  const found = await deps.cache.get([...byKey.keys()]);
  const missing = [...byKey.keys()].filter((k) => !found.has(k));

  const CHUNK = 1000;
  let geocoded = 0;
  for (let i = 0; i < missing.length && !deps.outOfTime(); i += CHUNK) {
    const ids = missing.slice(i, i + CHUNK);
    try {
      const res = await deps.geocoder.batch(ids.map((id) => ({ id, ...byKey.get(id)! })));
      const fresh = new Map<string, GeoResult>();
      for (const [id, r] of res) fresh.set(id, r ? { lat: round(r.lat), lon: round(r.lon) } : null);
      await deps.cache.set(fresh);
      for (const [id, r] of fresh) found.set(id, r);
      geocoded += fresh.size;
    } catch (err) {
      deps.log("geocoding failed; those homes stay off the map until a later run", { error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  if (missing.length) deps.log("campminder homes geocoded", { addresses: byKey.size, cached: byKey.size - missing.length, geocoded });
  return { homes: found, complete: found.size === byKey.size };
}

/** Minimal CSV line parser (quoted fields, doubled quotes). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const csvField = (v: string) => `"${v.replace(/"/g, '""')}"`;

/**
 * US Census Bureau batch geocoder: free, no key, up to 10,000 addresses per
 * request. https://geocoding.geo.census.gov/geocoder/
 */
export class CensusGeocoder implements Geocoder {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly url = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
  ) {}

  async batch(addresses: Array<{ id: string } & HomeAddress>): Promise<Map<string, GeoResult>> {
    const csv = addresses.map((a) => [a.id, a.street, a.city, a.state, a.zip].map(csvField).join(",")).join("\n");
    const form = new FormData();
    form.set("benchmark", "Public_AR_Current");
    form.set("addressFile", new Blob([csv], { type: "text/csv" }), "addresses.csv");
    const res = await this.fetchImpl(this.url, { method: "POST", body: form, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`Census geocoder answered ${res.status}`);
    const out = new Map<string, GeoResult>();
    for (const line of (await res.text()).split(/\r?\n/)) {
      if (!line.trim()) continue;
      // id, input address, Match|No_Match|Tie, Exact|Non_Exact, matched address, "lon,lat", ...
      const [id, , status, , , coords] = parseCsvLine(line);
      if (!id) continue;
      const [lon, lat] = (coords ?? "").split(",").map(Number);
      out.set(id, status === "Match" && Number.isFinite(lat) && Number.isFinite(lon) ? { lat: lat!, lon: lon! } : null);
    }
    return out;
  }
}

/** Cache in Firestore (clients can't read it; see infra/firestore.rules). */
export class FirestoreGeoCache implements GeoCache {
  constructor(private readonly db: Firestore) {}
  private col() {
    return this.db.collection("campminder_geocodes");
  }

  async get(keys: string[]) {
    const out = new Map<string, GeoResult>();
    for (let i = 0; i < keys.length; i += 300) {
      const refs = keys.slice(i, i + 300).map((k) => this.col().doc(k));
      if (!refs.length) continue;
      for (const snap of await this.db.getAll(...refs)) {
        if (!snap.exists) continue;
        const d = snap.data() as { lat: number | null; lon: number | null };
        out.set(snap.id, d.lat === null || d.lon === null ? null : { lat: d.lat, lon: d.lon });
      }
    }
    return out;
  }

  async set(entries: Map<string, GeoResult>) {
    const list = [...entries];
    for (let i = 0; i < list.length; i += 400) {
      const batch = this.db.batch();
      for (const [k, v] of list.slice(i, i + 400)) batch.set(this.col().doc(k), { lat: v?.lat ?? null, lon: v?.lon ?? null, at: new Date() });
      await batch.commit();
    }
  }
}
