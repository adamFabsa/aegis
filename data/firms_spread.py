"""Eaton Fire calibration targets from NASA FIRMS + IEM wind.

    data/.venv/bin/python data/firms_spread.py

Inputs  data/raw/firms_*_2025_US.csv, data/raw/wind_BUR.csv (from fetch_data.py)
Outputs data/out/eaton_firms.csv     detections in the Eaton bbox, Jan 7-10 2025 (also loaded into Tiger Data)
        data/out/eaton_spread.json   per-overpass front distance / speed (same logic as data/sql/spread.sql)
        data/out/wind_replay.json    hourly wind from ignition, rotated into map coordinates

Method (kept deliberately simple and explainable):
  * Ignition time: 2025-01-07 18:18 PST (first reported). Ignition point: the most upwind detection
    of the first satellite pass (projected on the observed wind axis) — i.e. the canyon head.
  * For every 1-hour bucket with detections: distance (km) from ignition to the farthest detection,
    its bearing, and average front speed = distance / hours since ignition.
  * The calibration target is the first-night front speed; the sim is tuned so its front moves at the
    same speed at our map scale (data/sim/calibrate.ts).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT / "out"

BBOX = dict(west=-118.25, south=34.10, east=-117.95, north=34.30)
IGNITION_LOCAL = pd.Timestamp("2025-01-07 18:18", tz="America/Los_Angeles")
MAP_WIND_TOWARD_DEG = 225.0  # our drawn hills sit NE of town, so the canyon wind blows toward map-SW
REPLAY_HOURS = 14
KT_TO_MPH = 1.15078


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(lon2 - lon1)
    x = np.sin(dl) * np.cos(p2)
    y = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return (np.degrees(np.arctan2(x, y)) + 360) % 360


def load_firms() -> pd.DataFrame:
    frames = []
    for f, sensor in [("firms_viirs_snpp_2025_US.csv", "VIIRS S-NPP"), ("firms_modis_2025_US.csv", "MODIS")]:
        df = pd.read_csv(RAW / f, dtype={"acq_time": str})
        m = (
            df.longitude.between(BBOX["west"], BBOX["east"])
            & df.latitude.between(BBOX["south"], BBOX["north"])
            & df.acq_date.isin(["2025-01-07", "2025-01-08", "2025-01-09", "2025-01-10"])
        )
        d = df[m].copy()
        d["time"] = pd.to_datetime(d.acq_date + " " + d.acq_time.str.zfill(4), format="%Y-%m-%d %H%M", utc=True)
        d["sensor"] = sensor
        d["confidence"] = d["confidence"].astype(str)
        frames.append(d[["time", "latitude", "longitude", "frp", "confidence", "sensor", "daynight"]])
    det = pd.concat(frames, ignore_index=True)
    # Only detections after ignition belong to Eaton (one stray pixel on Jan 7 01:00 is not the fire).
    det = det[det.time >= IGNITION_LOCAL.tz_convert("UTC")].sort_values("time").reset_index(drop=True)
    return det


def load_wind(station: str = "BUR") -> pd.DataFrame:
    w = pd.read_csv(RAW / f"wind_{station}.csv")
    w["valid"] = pd.to_datetime(w["valid"]).dt.tz_localize("America/Los_Angeles")
    for c in ["sknt", "drct", "gust"]:
        w[c] = pd.to_numeric(w[c], errors="coerce")
    return w


def circular_mean(deg: pd.Series, weight: pd.Series | None = None) -> float:
    r = np.radians(deg.astype(float))
    wt = np.ones(len(r)) if weight is None else weight.astype(float).fillna(0).to_numpy()
    s, c = np.nansum(np.sin(r) * wt), np.nansum(np.cos(r) * wt)
    return float((math.degrees(math.atan2(s, c)) + 360) % 360)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    det = load_firms()
    det.to_csv(OUT / "eaton_firms.csv", index=False)

    wind = load_wind("BUR")
    first6 = wind[(wind.valid >= IGNITION_LOCAL) & (wind.valid < IGNITION_LOCAL + pd.Timedelta(hours=6))].dropna(subset=["drct", "sknt"])
    mean_from = circular_mean(first6.drct, first6.sknt)
    mean_toward = (mean_from + 180) % 360

    # Ignition point = most upwind detection of the first pass.
    first_time = det.time.min()
    first_pass = det[det.time <= first_time + pd.Timedelta(minutes=30)]
    ux, uy = math.sin(math.radians(mean_from)), math.cos(math.radians(mean_from))  # unit vector pointing upwind (E, N)
    proj = (first_pass.longitude * math.cos(math.radians(34.2)) * ux + first_pass.latitude * uy)
    ign = first_pass.loc[proj.idxmax()]
    ign_lat, ign_lon = float(ign.latitude), float(ign.longitude)

    det["km"] = haversine_km(ign_lat, ign_lon, det.latitude, det.longitude)
    det["bearing"] = bearing_deg(ign_lat, ign_lon, det.latitude, det.longitude)
    det["bucket"] = det.time.dt.floor("1h")  # == time_bucket('1 hour', time)
    buckets = []
    for b, g in det.groupby("bucket"):
        far = g.loc[g.km.idxmax()]
        hrs = (g.time.mean() - IGNITION_LOCAL.tz_convert("UTC")).total_seconds() / 3600
        buckets.append({
            "bucketUtc": b.isoformat(),
            "bucketLocal": b.tz_convert("America/Los_Angeles").isoformat(),
            "detections": int(len(g)),
            "sensors": sorted(g.sensor.unique().tolist()),
            "hoursSinceIgnition": round(hrs, 2),
            "maxKmFromIgnition": round(float(far.km), 2),
            "bearingOfFarthestDeg": round(float(far.bearing), 1),
            "frontSpeedKmh": round(float(far.km) / hrs, 3) if hrs > 0 else None,
            "totalFrpMw": round(float(g.frp.sum()), 1),
        })
    first = buckets[0]
    spread = {
        "source": "NASA FIRMS VIIRS S-NPP + MODIS (yearly US archive), bbox " + json.dumps(BBOX),
        "ignitionLocal": IGNITION_LOCAL.isoformat(),
        "ignitionPoint": {"lat": ign_lat, "lon": ign_lon, "method": "most upwind detection of first overpass"},
        "windStation": "BUR (Burbank) ASOS via Iowa Environmental Mesonet",
        "meanWindFromDegFirst6h": round(mean_from, 1),
        "meanWindTowardDegFirst6h": round(mean_toward, 1),
        "meanWindMphFirst6h": round(float(first6.sknt.mean() * KT_TO_MPH), 1),
        "maxGustMphFirst6h": round(float(first6.gust.max() * KT_TO_MPH), 1),
        "firstPass": first,
        "targetFrontSpeedKmh": first["frontSpeedKmh"],
        "buckets": buckets,
    }
    (OUT / "eaton_spread.json").write_text(json.dumps(spread, indent=2))

    # Hourly wind replay from ignition, rotated so the observed mean axis maps onto the drawn canyon.
    rotation = MAP_WIND_TOWARD_DEG - mean_toward
    replay = []
    for h in range(REPLAY_HOURS):
        t0 = IGNITION_LOCAL.floor("1h") + pd.Timedelta(hours=h)
        win = wind[(wind.valid >= t0) & (wind.valid < t0 + pd.Timedelta(hours=1))]
        good = win.dropna(subset=["sknt"])
        dirs = win.dropna(subset=["drct", "sknt"])
        mph = float(good.sknt.mean() * KT_TO_MPH) if len(good) else replay[-1]["mph"]
        gust = float(win.gust.max() * KT_TO_MPH) if win.gust.notna().any() else mph
        toward = ((circular_mean(dirs.drct, dirs.sknt) + 180) % 360) if len(dirs) else (replay[-1]["realTowardDeg"])
        minute = 0 if h == 0 else int((t0 - IGNITION_LOCAL).total_seconds() // 60)
        replay.append({
            "minute": minute,
            "localTime": t0.strftime("%a %H:%M"),
            "realTowardDeg": round(toward, 1),
            "dirDeg": round((toward + rotation) % 360, 1),
            "mph": round(mph, 1),
            "gustMph": round(max(gust, mph), 1),
        })
    (OUT / "wind_replay.json").write_text(json.dumps({"station": "BUR", "rotationDeg": round(rotation, 1), "samples": replay}, indent=2))

    print(f"detections: {len(det)} | ignition point {ign_lat:.4f},{ign_lon:.4f}")
    print(f"wind first 6h: from {mean_from:.0f}° (toward {mean_toward:.0f}°), {spread['meanWindMphFirst6h']} mph, gust {spread['maxGustMphFirst6h']} mph; map rotation {rotation:+.0f}°")
    for b in buckets[:6]:
        print(f"  {b['bucketLocal'][:16]}  n={b['detections']:3d}  {b['hoursSinceIgnition']:5.2f}h  max {b['maxKmFromIgnition']:5.2f} km  → {b['frontSpeedKmh']} km/h  bearing {b['bearingOfFarthestDeg']}")


if __name__ == "__main__":
    main()
