"""Download every public dataset the Lantern pipeline uses into data/raw/ (gitignored).

    data/.venv/bin/python data/fetch_data.py            # everything
    data/.venv/bin/python data/fetch_data.py dins wind  # just some

Sources (all free, no signup needed for these endpoints):
  firms  NASA FIRMS yearly US archives, VIIRS S-NPP + MODIS (keyless). If FIRMS_MAP_KEY is set we
         also pull the area API for the Eaton bbox, Jan 7-9 2025 (VIIRS NOAA-20/21 add more passes).
  wind   Iowa Environmental Mesonet ASOS: Burbank (BUR) + El Monte (EMT), Jan 7-9 2025.
  dins   CAL FIRE Damage Inspection (DINS) database, ArcGIS FeatureServer POSTFIRE_MASTER_DATA_SHARE
         (~130k inspected structures, every CA wildfire since 2013).
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

RAW = Path(__file__).resolve().parent / "raw"
UA = {"User-Agent": "lantern-hackutd-data-pipeline"}

FIRMS_YEARLY = {
    "firms_viirs_snpp_2025_US.csv": "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/2025/viirs-snpp_2025_United_States.csv",
    "firms_modis_2025_US.csv": "https://firms.modaps.eosdis.nasa.gov/data/country/modis/2025/modis_2025_United_States.csv",
}
EATON_BBOX = "-118.25,34.10,-117.95,34.30"  # west,south,east,north
FIRMS_AREA_SOURCES = ["VIIRS_NOAA20_SP", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_SP", "MODIS_SP"]

DINS_URL = "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0/query"
DINS_FIELDS = [
    "OBJECTID", "DAMAGE", "STRUCTURETYPE", "STRUCTURECATEGORY", "INCIDENTNAME", "INCIDENTSTARTDATE",
    "ROOFCONSTRUCTION", "EAVES", "VENTSCREEN", "EXTERIORSIDING", "WINDOWPANE", "DECKPORCHONGRADE",
    "DECKPORCHELEVATED", "PATIOCOVERCARPORT", "FENCEATTACHEDTOSTRUCTURE", "YEARBUILT",
    "WHATDIDFIRESTARTFROM", "WHEREFIRESTARTEDONSTRUCTURE", "ASSESSEDIMPROVEDVALUE", "LATITUDE", "LONGITUDE",
]


def get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retry anything transient
            wait = 3 * (attempt + 1)
            print(f"  retry {attempt + 1} in {wait}s: {e}", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed: {url}")


def fetch_firms() -> None:
    for name, url in FIRMS_YEARLY.items():
        out = RAW / name
        if out.exists() and out.stat().st_size > 1_000_000:
            print(f"firms: have {name}")
            continue
        print(f"firms: downloading {name}")
        out.write_bytes(get(url, timeout=600))
    key = os.environ.get("FIRMS_MAP_KEY")
    if not key:
        print("firms: FIRMS_MAP_KEY not set — skipping area API (yearly archives are enough)")
        return
    for src in FIRMS_AREA_SOURCES:
        url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{src}/{EATON_BBOX}/3/2025-01-07"
        out = RAW / f"firms_area_{src}.csv"
        print(f"firms: area API {src}")
        out.write_bytes(get(url))


def fetch_wind() -> None:
    for st in ["BUR", "EMT"]:
        out = RAW / f"wind_{st}.csv"
        if out.exists() and out.stat().st_size > 5000:
            print(f"wind: have {st}")
            continue
        q = urllib.parse.urlencode(
            [("station", st), ("data", "sknt"), ("data", "drct"), ("data", "gust"),
             ("year1", 2025), ("month1", 1), ("day1", 7), ("year2", 2025), ("month2", 1), ("day2", 9),
             ("tz", "America/Los_Angeles"), ("format", "onlycomma"), ("missing", "empty")]
        )
        print(f"wind: downloading {st}")
        body = get(f"https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?{q}")
        if b"Too many requests" in body[:200]:
            print("wind: IEM rate limit — wait a minute and re-run", file=sys.stderr)
            continue
        out.write_bytes(body)
        time.sleep(6)  # IEM asks for gentle use


def fetch_dins() -> None:
    out = RAW / "dins_structures.csv"
    if out.exists() and out.stat().st_size > 5_000_000:
        print("dins: have dins_structures.csv")
        return
    count = json.loads(get(f"{DINS_URL}?where=1%3D1&returnCountOnly=true&f=json"))["count"]
    print(f"dins: {count} structures")
    page = 2000
    tmp = out.with_suffix(".part")
    with tmp.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=DINS_FIELDS)
        w.writeheader()
        last_oid = 0
        got = 0
        while True:
            q = urllib.parse.urlencode({
                "where": f"OBJECTID > {last_oid}",
                "outFields": ",".join(DINS_FIELDS),
                "orderByFields": "OBJECTID ASC",
                "resultRecordCount": page,
                "returnGeometry": "false",
                "f": "json",
            })
            data = json.loads(get(f"{DINS_URL}?{q}"))
            feats = data.get("features", [])
            if not feats:
                break
            for f in feats:
                a = f["attributes"]
                w.writerow({k: a.get(k) for k in DINS_FIELDS})
                last_oid = max(last_oid, a["OBJECTID"])
            got += len(feats)
            print(f"  dins {got}/{count}")
    tmp.rename(out)


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    wanted = set(sys.argv[1:]) or {"firms", "wind", "dins"}
    if "firms" in wanted:
        fetch_firms()
    if "wind" in wanted:
        fetch_wind()
    if "dins" in wanted:
        fetch_dins()


if __name__ == "__main__":
    main()
