import { describe, expect, it } from "vitest";
import { addressKey, CensusGeocoder, homeAddress, locateHomes, parseCsvLine, type GeoCache, type Geocoder, type GeoResult } from "./geocode.js";

// Made-up addresses.
const row = (street: string, zip = "20001-1234") => ({
  "Primary Childhood HomeAddr1": street,
  "Primary Childhood HomeCity": "Washington",
  "Primary Childhood HomeState": "DC",
  "Primary Childhood HomeZip": zip,
});
const KEY = "k".repeat(40);

class MemoryCache implements GeoCache {
  m = new Map<string, GeoResult>();
  async get(keys: string[]) {
    return new Map(keys.filter((k) => this.m.has(k)).map((k) => [k, this.m.get(k)!]));
  }
  async set(e: Map<string, GeoResult>) {
    for (const [k, v] of e) this.m.set(k, v);
  }
}

class FakeGeocoder implements Geocoder {
  calls = 0;
  fail = false;
  async batch(addresses: Array<{ id: string; street: string }>) {
    this.calls++;
    if (this.fail) throw new Error("down");
    return new Map(addresses.map((a) => [a.id, a.street.startsWith("0 ") ? null : { lat: 38.9012345, lon: -77.0123456 }]));
  }
}

const deps = (cache: GeoCache, geocoder: Geocoder, outOfTime = () => false) => ({ cache, geocoder, outOfTime, log: () => {} });

describe("home addresses", () => {
  it("needs a street and a ZIP (or city and state)", () => {
    expect(homeAddress(row("1 Test St"))).toEqual({ street: "1 Test St", city: "Washington", state: "DC", zip: "20001" });
    expect(homeAddress(row(""))).toBeNull();
    expect(homeAddress({ "Primary Childhood HomeAddr1": "1 Test St" })).toBeNull();
  });

  it("keys addresses by a keyed hash, ignoring case and spacing", () => {
    const a = homeAddress(row("1  Test St"))!;
    const b = homeAddress(row("1 test st"))!;
    expect(addressKey(a, KEY)).toBe(addressKey(b, KEY));
    expect(addressKey(a, KEY)).not.toContain("Test");
  });
});

describe("locateHomes", () => {
  it("geocodes each address once, caching matches and misses", async () => {
    const cache = new MemoryCache();
    const g = new FakeGeocoder();
    const addrs = [homeAddress(row("1 Test St"))!, homeAddress(row("0 Nowhere Rd"))!, homeAddress(row("1 Test St"))!];
    const { homes: first, complete } = await locateHomes(addrs, KEY, deps(cache, g));
    expect(complete).toBe(true);
    expect(first.get(addressKey(addrs[0]!, KEY))).toEqual({ lat: 38.90123, lon: -77.01235 });
    expect(first.get(addressKey(addrs[1]!, KEY))).toBeNull();
    await locateHomes(addrs, KEY, deps(cache, g));
    expect(g.calls).toBe(1);
  });

  it("carries on without coordinates when the geocoder is down or time is up", async () => {
    const g = new FakeGeocoder();
    g.fail = true;
    const addrs = [homeAddress(row("1 Test St"))!];
    expect(await locateHomes(addrs, KEY, deps(new MemoryCache(), g))).toEqual({ homes: new Map(), complete: false });
    const late = new FakeGeocoder();
    expect((await locateHomes(addrs, KEY, deps(new MemoryCache(), late, () => true))).complete).toBe(false);
    expect(late.calls).toBe(0);
  });
});

describe("Census geocoder", () => {
  it("sends quoted CSV and reads matches", async () => {
    let sent = "";
    const fakeFetch = (async (_url: string, init: { body: FormData }) => {
      sent = await (init.body.get("addressFile") as Blob).text();
      return new Response(
        '"a","1 TEST ST, WASHINGTON, DC, 20001","Match","Exact","1 TEST ST NW, WASHINGTON, DC, 20001","-77.0123,38.9012","123","L"\n' +
          '"b","0 NOWHERE RD, WASHINGTON, DC, 20001","No_Match"\n',
      );
    }) as unknown as typeof fetch;
    const res = await new CensusGeocoder(fakeFetch).batch([
      { id: "a", street: '1 "Test" St', city: "Washington", state: "DC", zip: "20001" },
      { id: "b", street: "0 Nowhere Rd", city: "Washington", state: "DC", zip: "20001" },
    ]);
    expect(sent.split("\n")[0]).toBe('"a","1 ""Test"" St","Washington","DC","20001"');
    expect(res.get("a")).toEqual({ lat: 38.9012, lon: -77.0123 });
    expect(res.get("b")).toBeNull();
    expect(parseCsvLine('"x,y",z')).toEqual(["x,y", "z"]);
  });
});
