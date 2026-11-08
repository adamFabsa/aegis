# Lantern data pipeline (Person A)

Everything shown on screen is either **real data** or **labelled simulated**. The neighbourhood, residents and
dollar values are fictional; the fire is calibrated to the real 2025 Eaton Fire; building risk is learned
from CAL FIRE's real damage inspections.

```bash
bash data/run_pipeline.sh                 # downloads (first run) → models → calibration → seed → tests (~30 s)
SKIP_FETCH=1 bash data/run_pipeline.sh    # reuse data/raw/
TIGER_DATABASE_URL=... data/.venv/bin/python data/tiger_load.py   # load + query in Tiger Data
```

## Sources (all public, no signup for these endpoints)

| Data | Where | Used for |
|---|---|---|
| NASA FIRMS active-fire detections, VIIRS S-NPP + MODIS, US 2025 (579,654 rows) | firms.modaps.eosdis.nasa.gov yearly country archives | Eaton front speed; Tiger Data hypertable |
| Wind, Burbank ASOS (BUR), Jan 7–9 2025 | Iowa Environmental Mesonet | Hour-by-hour wind replay from ignition |
| CAL FIRE Damage Inspection (DINS), 132,522 structures, 2013–2025 | CAL FIRE ArcGIS `POSTFIRE_MASTER_DATA_SHARE` | Building risk model, pitch stats |

## Fire calibration (`firms_spread.py`, `sim/calibrate.ts`)

- Ignition 2025-01-07 18:18 PST; ignition point = most upwind detection of the first pass (34.2011, −118.0817).
- First satellite pass (MODIS, 2.38 h after ignition): farthest detection **4.58 km** away, bearing 224°
  → average front speed **1.92 km/h**. The same number comes out of `sql/spread.sql` (`time_bucket('1 hour')`)
  inside the database.
- Wind first 6 h: from 20° (NNE) at 28 mph, gusts to 71 mph. The replay is rotated +25° so the real wind
  axis lines up with our drawn canyon (the real fire ran toward 224°; our map's canyon axis is 225°).
- Calibrated so the simulated front on dry brush moves at **1.95 km/h** at our map scale (6 m per map unit,
  map ≈ 6 km × 3.7 km, so canyon → town ≈ Eaton Canyon → Altadena). Embers (spotting) scale with gusts and are
  the only way across roads. Building 12: fire arrives in ~1h46m (median of 400 simulated fires).
- `buildingIgniteK` is fitted so a building the fire reaches is lost with probability ≈ its model risk.

## Building risk model (`risk_model.py`)

Logistic regression, target = destroyed (>50%), trained on **35,062** residential/commercial structures with
all six features recorded, from 41 fires / 2,498 neighbourhoods (fire × ~1 km cell fixed effects, so features
are compared on the same streets in the same fire). Features: roof, eaves, vents, siding, windows, year-built
band (2008+ = California's WUI building code). Intercept recalibrated to the Eaton Fire's real 49.7% destroyed
rate. AUC 0.94 (random holdout, with neighbourhood effects); 0.67 construction-only on fires never seen.

Dropped on purpose: attached fence, deck, patio cover — inspectors record them after the fire, and on destroyed
homes they burn away and get logged as "none" (raw data says homes with no fence burned *more* — an artifact).
"Clear brush to 30 ft" is therefore not a DINS number: its risk drop comes from the fire simulation and is
labelled "simulated".

**Honest stats for the pitch** (raw rates, CAL FIRE DINS, Eaton Fire):
- Unscreened or coarse vents: destroyed **43%** of the time vs **24%** with ember-resistant ≤1/8″ mesh (n = 6,901 vs 1,277).
- Open eaves 26% vs enclosed 11% (n = 5,675 vs 1,659). Single-pane windows 37% vs multi-pane 23%.
- Across all CA fires since 2013: built before 1960 destroyed 59% vs 29% for homes built 2008+ under the WUI code (n = 25,293 vs 2,712).

Caveat to say out loud: DINS covers structures inside fire perimeters; this is association, not an experiment.

## Simulated results (same fire, with vs without Lantern)

Averaged over 40 simulated Eaton-calibrated fires, playing the demo (van + brush on Building 12, van on
Building 9, recommended fixes, evacuate the four threatened buildings at once): **+7.8 people safe, ~1 fewer
building lost, $16.6M less damage** vs the same fire with no prep, late evacuation and no check-ins. The demo
fire (`fireSeed` 20250135) is the one closest to that average (+7 people, 1 building, $12M), not the best one.

## Files

| File | What |
|---|---|
| `fetch_data.py` | Downloads → `data/raw/` (gitignored) |
| `firms_spread.py` | → `out/eaton_spread.json`, `out/wind_replay.json`, `out/eaton_firms.csv` |
| `risk_model.py` | → `out/risk_model.json`, `out/building_risk.json` |
| `neighborhood.json` | The fictional neighbourhood: map geometry, buildings, construction features, fixes |
| `sim/seed_lib.ts`, `sim/make_seed.ts` | → `seed/*.json`, `spacetimedb/src/seed_data.ts` |
| `sim/calibrate.ts` | → `out/calibration.json` (fire constants, map scale, brush effect, prep ETAs) |
| `sim/pick_demo_seed.ts` | Representative demo fire |
| `sql/schema.sql`, `sql/spread.sql`, `tiger_load.py` | Tiger Data hypertables + spread query |

Libraries: pandas, NumPy, scikit-learn, psycopg 3 (Python); Node 22 built-ins only for the TS scripts.
