#!/usr/bin/env python3
"""
Build services/api/data/official-schools.json: every open public and private
school in DC, Maryland and Virginia, from the U.S. Department of Education
(NCES). Public schools come from the Common Core of Data (through the Urban
Institute's Education Data API, which serves it as JSON); private schools
from the Private School Universe Survey. Each survey year's public file only
has the private schools that answered that year, so every year back to
2013-14 is combined (newest record wins), and a private school listed once
per campus (Sidwell Friends) is kept once. Names a school had in an earlier
year are kept as former names, so "Wilson High School" still finds
Jackson-Reed. A charter school with a few campuses ("Mundo Verde Bilingual
PCS - Calle Ocho" and "- J.F. Cook") is kept as one school, the way families
name it; large networks (KIPP DC, Friendship) keep their campuses, which are
different schools. Schools in the counties camp families mostly come from are
marked "nearby", which the matcher prefers when two schools share a name.

Run it about once a year, when NCES publishes new data:

    python3 scripts/fetch_official_schools.py

Standard library only. Needs network access to educationdata.urban.org and
nces.ed.gov.
"""

import csv
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

STATES = {"DC": 11, "MD": 24, "VA": 51}
OUT = Path(__file__).resolve().parent.parent / "services" / "api" / "data" / "official-schools.json"
URBAN = "https://educationdata.urban.org/api/v1"
PSS_PAGE = "https://nces.ed.gov/surveys/pss/pssdata.asp"

# Common Core of Data: school_status 2 = closed, 6 = inactive.
CLOSED = {2, 6}

# Where most camp families' schools are; the matcher prefers these when two schools share a name.
NEARBY = {
    ("DC", "District of Columbia"),
    ("MD", "Montgomery County"),
    ("MD", "Frederick County"),
    ("MD", "Prince George's County"),
    ("MD", "Howard County"),
    ("VA", "Arlington County"),
    ("VA", "Fairfax County"),
    ("VA", "Fairfax City"),
    ("VA", "Alexandria City"),
    ("VA", "Falls Church City"),
    ("VA", "Loudoun County"),
}


def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def urban(path: str) -> list[dict]:
    """Every result of an Education Data API query, following its pages."""
    out, url = [], f"{URBAN}/{path}"
    while url:
        page = json.loads(get(url))
        out += page.get("results") or []
        url = page.get("next")
    return out


def latest_ccd_year() -> int:
    for year in (2025, 2024, 2023, 2022):
        if urban(f"schools/ccd/directory/{year}/?fips=11"):
            return year
    sys.exit("No recent Common Core of Data year found")


SMALL = {"of", "the", "and", "for", "at", "in", "on", "de", "la", "du", "a"}
KEEP_UPPER = {"DC", "II", "III", "IV", "KIPP", "SEED", "STEM", "STEAM", "YMCA", "JCC", "PG", "USA", "US", "MD", "VA"}


def title(name: str) -> str:
    """Private school names arrive in capitals: "ST. ALBANS SCHOOL" → "St. Albans School"."""
    words = []
    for i, w in enumerate(name.split()):
        bare = re.sub(r"[^A-Za-z]", "", w).upper()
        if bare in KEEP_UPPER:
            words.append(w.upper())
        elif i > 0 and w.lower() in SMALL:
            words.append(w.lower())
        else:
            # Capitalize each part of hyphenated/apostrophe words: "HOLTON-ARMS", "O'CONNELL".
            words.append(re.sub(r"[A-Za-z]+", lambda m: m.group(0).capitalize(), w.lower()))
    s = " ".join(words)
    return re.sub(r"'S\b", "'s", s)


def county_name(raw: str | None, state: str) -> str | None:
    if state == "DC":
        return "District of Columbia"
    if not raw:
        return None
    n = title(raw.strip())
    n = re.sub(r"\bPrince George'S\b", "Prince George's", n)
    return n if re.search(r"\b(County|City)$", n) else f"{n} County"


def ccd_level(r: dict) -> str:
    lvl = r.get("school_level")
    if lvl == 1:
        return "elementary"
    if lvl == 2:
        return "middle"
    if lvl == 3:
        return "high"
    lo, hi = r.get("lowest_grade_offered"), r.get("highest_grade_offered")
    if isinstance(lo, int) and isinstance(hi, int) and hi >= 0:
        if hi <= 5:
            return "elementary"
        if lo >= 9:
            return "high"
        if lo >= 5 and hi <= 8:
            return "middle"
    return ""


def public_schools() -> list[dict]:
    year = latest_ccd_year()
    print(f"Public schools: Common Core of Data {year}", file=sys.stderr)
    counties = {}
    for fips in STATES.values():
        for d in urban(f"school-districts/ccd/directory/{year}/?fips={fips}"):
            if d.get("county_code") and d.get("county_name"):
                counties[str(d["county_code"])] = d["county_name"]
    # Names from a few years back, for schools that have been renamed since.
    old = {}
    for fips in STATES.values():
        for r in urban(f"schools/ccd/directory/{year - 5}/?fips={fips}"):
            old[r["ncessch"]] = r["school_name"]
    out = []
    for state, fips in STATES.items():
        for r in urban(f"schools/ccd/directory/{year}/?fips={fips}"):
            if r.get("school_status") in CLOSED or not r.get("school_name"):
                continue
            name = r["school_name"].strip()
            former = old.get(r["ncessch"])
            out.append(
                {
                    "id": f"nces-{r['ncessch']}",
                    "name": name,
                    "level": ccd_level(r),
                    "type": "public",
                    "state": state,
                    "county": county_name(counties.get(str(r.get("county_code"))), state),
                    "city": r.get("city_location"),
                    **({"formerNames": [former.strip()]} if former and former.strip().lower() != name.lower() else {}),
                }
            )
    return out


def merge_campuses(schools: list[dict], most: int = 3) -> list[dict]:
    """One school per charter with up to `most` campuses: "X PCS - Campus" → "X PCS"."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for s in schools:
        if " - " in s["name"]:
            groups.setdefault((s["state"], s["name"].split(" - ")[0].strip()), []).append(s)
    merged_ids = set()
    out = []
    for (state, prefix), campuses in groups.items():
        if not 2 <= len(campuses) <= most:
            continue
        campuses.sort(key=lambda c: c["id"])
        first = campuses[0]
        levels = {c["level"] for c in campuses}
        out.append(
            {
                **first,
                "name": prefix,
                "level": levels.pop() if len(levels) == 1 else "",
                "formerNames": sorted({c["name"] for c in campuses} | {n for c in campuses for n in c.get("formerNames", [])}),
            }
        )
        merged_ids |= {c["id"] for c in campuses}
    return [s for s in schools if s["id"] not in merged_ids] + out


def pss_files() -> list[str]:
    """Private School Universe Survey CSV zips, newest first."""
    html = get(PSS_PAGE).decode("latin-1")
    return sorted(set(re.findall(r"zip/(pss\d{4}_pu_csv\.zip)", html)), reverse=True)


def pss_rows(file: str) -> list[dict]:
    z = zipfile.ZipFile(io.BytesIO(get(f"https://nces.ed.gov/surveys/pss/zip/{file}")))
    name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
    return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding="latin-1")))


def private_schools() -> list[dict]:
    files = [f for f in pss_files() if int(f[3:5]) >= 13]
    if not files:
        sys.exit("No Private School Universe Survey files found")
    print(f"Private schools: {', '.join(files)}", file=sys.stderr)
    newest: dict[str, dict] = {}
    names: dict[str, list[str]] = {}
    for f in files:
        for r in pss_rows(f):
            # Where the school is (PL_…, filled in only when it differs from the mailing address).
            state = (r.get("PL_STABB") or "").strip() or (r.get("PSTABB") or "").strip()
            if state not in STATES or not r.get("PINST"):
                continue
            names.setdefault(r["PPIN"], []).append(title(r["PINST"].strip()))
            if r["PPIN"] in newest:
                continue
            newest[r["PPIN"]] = {
                "id": f"nces-pss-{r['PPIN']}",
                "name": title(r["PINST"].strip()),
                # Private schools' levels are left to their names: "St. Bartholomew School" runs K-8.
                "level": "",
                "type": "private",
                "state": state,
                "county": county_name(r.get("PCNTNM"), state),
                "city": title((r.get("PL_CIT") or "").strip() or (r.get("PCITY") or "").strip()) or None,
            }
    out, by_name = [], {}
    for ppin, s in newest.items():
        former = sorted({n for n in names[ppin] if n.lower() != s["name"].lower()})
        if former:
            s["formerNames"] = former
        # One school per name: campuses and divisions of a private school are one school.
        key = re.sub(r"[^a-z0-9]", "", s["name"].lower())
        if key in by_name:
            kept = by_name[key]
            merged = sorted(set(kept.get("formerNames", [])) | set(former))
            if merged:
                kept["formerNames"] = merged
            continue
        by_name[key] = s
        out.append(s)
    return out


def main() -> None:
    schools = merge_campuses(public_schools()) + private_schools()
    for s in schools:
        if (s["state"], s["county"]) in NEARBY:
            s["nearby"] = True
    schools.sort(key=lambda s: (s["state"], s["name"].lower(), s["id"]))
    OUT.write_text("[\n" + ",\n".join(json.dumps(s, ensure_ascii=False) for s in schools) + "\n]\n")
    by = {}
    for s in schools:
        by[(s["state"], s["type"])] = by.get((s["state"], s["type"]), 0) + 1
    print(f"Wrote {len(schools)} schools to {OUT}: {by}", file=sys.stderr)


if __name__ == "__main__":
    main()
