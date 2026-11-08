"""Load FIRMS detections, wind and CAL FIRE DINS into Tiger Data, then run the spread-rate query there.

    export TIGER_DATABASE_URL='postgres://tsdbadmin:...@....tsdb.cloud.timescale.com:5432/tsdb?sslmode=require'
    data/.venv/bin/python data/tiger_load.py

    # local Postgres without TimescaleDB (testing only: time_bucket is shimmed with date_bin):
    data/.venv/bin/python data/tiger_load.py --local postgresql:///lantern_tiger_test

Inputs  data/raw/firms_*_2025_US.csv, data/raw/wind_BUR.csv, data/raw/dins_structures.csv, data/out/eaton_spread.json
Prints  the hourly front-speed table computed IN the database (data/sql/spread.sql) next to the pandas
        result, plus the vent-screen stat from DINS — the same numbers the sim is calibrated on.
"""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import pandas as pd
import psycopg

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT / "out"
SQL = ROOT / "sql"

TIME_BUCKET_SHIM = """
CREATE OR REPLACE FUNCTION time_bucket(bucket interval, ts timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$ SELECT date_bin(bucket, ts, TIMESTAMPTZ '2000-01-03 00:00:00+00') $$;
"""


def firms_frame() -> pd.DataFrame:
    frames = []
    for f, sensor in [("firms_viirs_snpp_2025_US.csv", "VIIRS S-NPP"), ("firms_modis_2025_US.csv", "MODIS")]:
        df = pd.read_csv(RAW / f, dtype={"acq_time": str})
        d = df.copy()  # all US detections of 2025 → a real time-series workload for the hypertable
        d["time"] = pd.to_datetime(d.acq_date + " " + d.acq_time.str.zfill(4), format="%Y-%m-%d %H%M", utc=True)
        d["sensor"] = sensor
        frames.append(d.rename(columns={"latitude": "lat", "longitude": "lon"})[["time", "lat", "lon", "frp", "confidence", "sensor", "daynight"]])
    return pd.concat(frames, ignore_index=True)


def copy_df(cur, table: str, df: pd.DataFrame) -> None:
    buf = io.StringIO()
    df.to_csv(buf, index=False, header=False)
    buf.seek(0)
    with cur.copy(f"COPY {table} ({', '.join(df.columns)}) FROM STDIN WITH (FORMAT csv)") as cp:
        cp.write(buf.read())


def main() -> None:
    local = "--local" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    url = args[0] if args else os.environ.get("TIGER_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("set TIGER_DATABASE_URL (Tiger Data service → Connect → connection string)")

    schema = (SQL / "schema.sql").read_text()
    if local:  # no TimescaleDB: plain tables + a time_bucket shim, for testing the SQL only
        schema = "\n".join(l for l in schema.splitlines() if "timescaledb" not in l and "create_hypertable" not in l)
        schema += TIME_BUCKET_SHIM

    with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("SET TIME ZONE 'UTC'")
        cur.execute(schema)
        cur.execute("TRUNCATE firms_detection, wind_obs, dins_structure")

        firms = firms_frame()
        copy_df(cur, "firms_detection", firms)
        print(f"firms_detection: {len(firms):,} US detections, 2025 (VIIRS S-NPP + MODIS)")

        w = pd.read_csv(RAW / "wind_BUR.csv")
        w["time"] = pd.to_datetime(w["valid"]).dt.tz_localize("America/Los_Angeles").dt.tz_convert("UTC")
        wind = pd.DataFrame({"time": w.time, "station": w.station, "knots": pd.to_numeric(w.sknt, errors="coerce"),
                             "dir_from": pd.to_numeric(w.drct, errors="coerce"), "gust_kt": pd.to_numeric(w.gust, errors="coerce")})
        copy_df(cur, "wind_obs", wind)
        print(f"wind_obs: {len(wind):,} observations (BUR)")

        d = pd.read_csv(RAW / "dins_structures.csv", low_memory=False)
        dins = pd.DataFrame({
            "objectid": d.OBJECTID, "damage": d.DAMAGE, "structure_type": d.STRUCTURETYPE,
            "structure_category": d.STRUCTURECATEGORY, "incident_name": d.INCIDENTNAME,
            "incident_start": pd.to_datetime(d.INCIDENTSTARTDATE, unit="ms", utc=True, errors="coerce"),
            "roof": d.ROOFCONSTRUCTION, "eaves": d.EAVES, "vent_screen": d.VENTSCREEN, "exterior_siding": d.EXTERIORSIDING,
            "window_pane": d.WINDOWPANE, "deck_on_grade": d.DECKPORCHONGRADE, "deck_elevated": d.DECKPORCHELEVATED,
            "patio_cover": d.PATIOCOVERCARPORT, "fence_attached": d.FENCEATTACHEDTOSTRUCTURE,
            "year_built": pd.to_numeric(d.YEARBUILT, errors="coerce").astype("Int64"),
            "fire_started_from": d.WHATDIDFIRESTARTFROM, "assessed_value": pd.to_numeric(d.ASSESSEDIMPROVEDVALUE, errors="coerce"),
            "lat": pd.to_numeric(d.LATITUDE, errors="coerce"), "lon": pd.to_numeric(d.LONGITUDE, errors="coerce"),
        }).drop_duplicates("objectid")
        copy_df(cur, "dins_structure", dins)
        print(f"dins_structure: {len(dins):,} structures")

        spread = json.loads((OUT / "eaton_spread.json").read_text())
        params = {"lat": spread["ignitionPoint"]["lat"], "lon": spread["ignitionPoint"]["lon"], "t0": spread["ignitionLocal"]}
        cur.execute((SQL / "spread.sql").read_text(), params)
        rows = cur.fetchall()
        print("\nEaton front speed, computed in the database (time_bucket 1 hour):")
        print(f"  {'bucket (UTC)':25s} {'n':>4s} {'hours':>6s} {'max km':>7s} {'km/h':>6s}")
        for b, n, _sensors, hrs, km, kmh, _frp in rows[:8]:
            print(f"  {str(b):25s} {n:4d} {float(hrs):6.2f} {float(km):7.2f} {float(kmh or 0):6.3f}")
        first_db = float(rows[0][5])
        print(f"first pass: {first_db} km/h in SQL vs {spread['targetFrontSpeedKmh']} km/h in pandas")

        cur.execute("""
            SELECT CASE WHEN vent_screen = 'Mesh Screen <= 1/8"' THEN 'fine mesh (<=1/8in)'
                        WHEN vent_screen IN ('Unscreened', 'Mesh Screen > 1/8"') THEN 'unscreened/coarse' END AS vents,
                   count(*), round(100.0 * avg((damage = 'Destroyed (>50%)')::int), 1) AS destroyed_pct
            FROM dins_structure
            WHERE incident_name = 'Eaton'
              AND structure_category IN ('Single Residence', 'Multiple Residence', 'Mixed Commercial/Residential', 'Nonresidential Commercial')
              AND damage <> 'Inaccessible'
              AND vent_screen IN ('Mesh Screen <= 1/8"', 'Unscreened', 'Mesh Screen > 1/8"')
            GROUP BY 1 ORDER BY 1
        """)
        print("\nEaton Fire, destroyed % by vent screen (DINS):")
        for v, n, pct in cur.fetchall():
            print(f"  {v:22s} n={n:6,d}  destroyed {pct}%")


if __name__ == "__main__":
    main()
