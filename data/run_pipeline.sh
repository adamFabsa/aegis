#!/usr/bin/env bash
# Rebuild every derived file from the public data, in order. ~1 minute (plus downloads on first run).
#   bash data/run_pipeline.sh            # everything
#   SKIP_FETCH=1 bash data/run_pipeline.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PY=data/.venv/bin/python
if [ ! -x "$PY" ]; then
  python3 -m venv data/.venv
  data/.venv/bin/pip install -q -r data/requirements.txt
fi
NODE="node --experimental-strip-types --no-warnings"

[ "${SKIP_FETCH:-0}" = "1" ] || $PY data/fetch_data.py   # NASA FIRMS, IEM wind, CAL FIRE DINS → data/raw/
$PY data/firms_spread.py                                 # → data/out/eaton_spread.json, wind_replay.json
$PY data/risk_model.py                                   # → data/out/risk_model.json, building_risk.json
$NODE data/sim/make_seed.ts > /dev/null                  # provisional seed (calibrate reads it)
$NODE data/sim/calibrate.ts                              # → data/out/calibration.json
$NODE data/sim/make_seed.ts > /dev/null
$NODE data/sim/pick_demo_seed.ts                         # representative demo fire → calibration.json
$NODE data/sim/make_seed.ts                              # → seed/*.json + spacetimedb/src/seed_data.ts
$NODE preview/build.ts                                   # → preview/index.html (same engine, in a browser)
$NODE --test spacetimedb/tests/sim.test.ts preview/test_preview.ts
# Optional: load into Tiger Data and re-run the spread query in the database
# TIGER_DATABASE_URL=... $PY data/tiger_load.py
