// Calibrates the fire/building constants against the real Eaton Fire and writes data/out/calibration.json.
//
//   node --experimental-strip-types data/sim/calibrate.ts && node --experimental-strip-types data/sim/make_seed.ts
//
// 1. baseSpread: on an open dry-brush grid with the replayed Eaton wind, the fire's farthest point after
//    the first FIRMS pass time (2.38 h) must sit at the same distance as in the satellite data, i.e. the
//    same average front speed (1.92 km/h) at our map scale.
// 2. metersPerUnit (map scale): chosen so the median fire arrival at Building 12 from the canyon is
//    ≈ 1h50m (the demo's "fire arrives in 1h50m, evacuation needs 3h"). ≈ 6 m/unit puts the hills→town
//    distance at the real Eaton Canyon → Altadena scale.
// 3. buildingIgniteK: a building the fire reaches is lost with probability ≈ its model risk.
// 4. Brush clearance riskDrop per building (not in DINS): simulated effect of a cleared, irrigated ring
//    around the footprint (lawn fuel 0.35 → 0.15), expressed as an equivalent risk drop.
// 5. Reference (prep-phase) fire ETA per building: median of many simulated fires from ignition.
import { writeFileSync } from 'node:fs';
import { assembleSeed, readJson, p_ } from './seed_lib.ts';
import type { Calibration } from './seed_lib.ts';
import { makeEngine, fireSubstep, windAt, mulberry32, referenceEtas, fmtMin } from '../../spacetimedb/src/sim.ts';
import type { FireParams, Engine, FireGrid, SeedBuilding } from '../../spacetimedb/src/sim.ts';

const B12_TARGET_MIN = 110;
const SCALES = [4, 6, 8];
const SPOT_PS = [0.008, 0.015, 0.03];
const BURNS = [5, 8, 12]; // vegetation burn duration (steps); buildings burn 1.6× longer
const spread = readJson<{ targetFrontSpeedKmh: number; firstPass: { hoursSinceIgnition: number; maxKmFromIgnition: number } }>('data/out/eaton_spread.json');
const targetKmh = spread.targetFrontSpeedKmh;
const passHours = spread.firstPass.hoursSinceIgnition;

function emptyGrid(n: number, nb: number): FireGrid {
  return { state: new Uint8Array(n), burn: new Uint8Array(n), bstate: new Uint8Array(nb), burning: [] };
}

/** Median FIRMS-style front speed (km/h) on an open brush grid. */
function syntheticSpeed(p: FireParams, runs: number, seed: number): number {
  const N = 160;
  const q: FireParams = { ...p, cols: N, rows: N };
  const fuel = new Array(N * N).fill(1);
  const eng = makeEngine(q, fuel, []);
  const rng = mulberry32(seed);
  const steps = Math.round((passHours * 60) / p.stepMinutes);
  const cx = 110;
  const cy = 40; // upwind side so a SW-running front has room
  const speeds: number[] = [];
  for (let r = 0; r < runs; r++) {
    const g = emptyGrid(N * N, 0);
    const c0 = cy * N + cx;
    g.state[c0] = 1;
    g.burning.push(c0);
    for (let s = 1; s <= steps && g.burning.length; s++) fireSubstep(eng, g, rng, windAt(p, s * p.stepMinutes));
    let maxD = 0;
    for (let i = 0; i < N * N; i++) {
      if (g.state[i] === 0) continue;
      const x = i % N;
      const y = (i - x) / N;
      maxD = Math.max(maxD, Math.hypot(x - cx, y - cy));
    }
    speeds.push((maxD * p.cellSize * p.metersPerUnit) / 1000 / passHours);
  }
  speeds.sort((a, b) => a - b);
  return speeds[Math.floor(speeds.length / 2)];
}

function fitBaseSpread(p: FireParams): number {
  let lo = 0.01;
  let hi = 1.5;
  for (let it = 0; it < 18; it++) {
    const mid = (lo + hi) / 2;
    const v = syntheticSpeed({ ...p, baseSpread: mid }, 25, 99);
    if (v < targetKmh) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10000) / 10000;
}

interface MapStats {
  reach: number[]; // fraction of runs the building was exposed
  median: number[]; // median arrival (minutes) when reached
  lostGivenExposed: number[];
  exposedRuns: number[];
  fireOutMedian: number;
}

function mapStats(p: FireParams, buildings: { id: number; x: number; y: number; w: number; h: number; risk: number }[], runs: number, seed: number, fuel = p.fuel): MapStats {
  const eng: Engine = makeEngine(p, fuel, buildings);
  const n = p.cols * p.rows;
  const nb = buildings.length;
  const rng = mulberry32(seed);
  const arrivals: number[][] = buildings.map(() => []);
  const exposedRuns = new Array(nb).fill(0);
  const lostRuns = new Array(nb).fill(0);
  const outs: number[] = [];
  const maxSteps = Math.ceil(p.maxSimMinutes / p.stepMinutes);
  for (let r = 0; r < runs; r++) {
    const g = emptyGrid(n, nb);
    for (const c of p.ignition) {
      g.state[c] = 1;
      g.burning.push(c);
    }
    const arr = new Array(nb).fill(Infinity);
    let s = 1;
    for (; s <= maxSteps && g.burning.length; s++) {
      const res = fireSubstep(eng, g, rng, windAt(p, s * p.stepMinutes));
      for (const b of res.exposed) if (arr[b] === Infinity) arr[b] = s * p.stepMinutes;
    }
    outs.push(s * p.stepMinutes);
    for (let b = 0; b < nb; b++) {
      if (arr[b] !== Infinity) {
        arrivals[b].push(arr[b]);
        exposedRuns[b]++;
        if (g.bstate[b] === 2) lostRuns[b]++;
      }
    }
  }
  outs.sort((a, b) => a - b);
  return {
    reach: exposedRuns.map((e) => e / runs),
    median: arrivals.map((xs) => {
      xs.sort((a, b) => a - b);
      return xs.length ? xs[Math.floor(xs.length / 2)] : -1;
    }),
    lostGivenExposed: exposedRuns.map((e, b) => (e ? lostRuns[b] / e : NaN)),
    exposedRuns,
    fireOutMedian: outs[Math.floor(outs.length / 2)],
  };
}

function riskRows(seedB: SeedBuilding[]) {
  return seedB.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, risk: b.baseRisk }));
}

/** K so that pooled P(lost | exposed) matches pooled risk among exposed buildings. */
function fitK(p: FireParams, rows: ReturnType<typeof riskRows>): number {
  let lo = 0.03;
  let hi = 2;
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    const st = mapStats({ ...p, buildingIgniteK: mid }, rows, 120, 7);
    let lost = 0;
    let want = 0;
    rows.forEach((b, i) => {
      lost += st.lostGivenExposed[i] * st.exposedRuns[i] || 0;
      want += (b.risk / 100) * st.exposedRuns[i];
    });
    if (lost < want) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}

const base = assembleSeed({ calibration: {} });
const rows = riskRows(base.buildings);
const i12 = base.buildings.findIndex((b) => b.id === 12);
console.log(`target: ${targetKmh} km/h front (FIRMS first pass ${spread.firstPass.maxKmFromIgnition} km at ${passHours} h); Building 12 median arrival ≈ ${fmtMin(B12_TARGET_MIN)}`);

type Cand = { m: number; spotP: number; burnSteps: number; baseSpread: number; K: number; st: MapStats; speed: number; score: number };
const cands: Cand[] = [];
for (const m of SCALES) {
  for (const spotP of SPOT_PS) for (const burnSteps of BURNS) {
    const p0: FireParams = { ...base.params, metersPerUnit: m, spotP, burnSteps, buildingBurnSteps: Math.round(burnSteps * 1.6) };
    const baseSpread = fitBaseSpread(p0);
    const p1 = { ...p0, baseSpread };
    const K = fitK(p1, rows);
    const p2 = { ...p1, buildingIgniteK: K };
    const st = mapStats(p2, rows, 200, 11);
    const speed = syntheticSpeed(p2, 40, 5);
    // Objective: Building 12 median ≈ target, reached reliably, fire keeps burning ≥ 4 h, speed on target.
    const score =
      Math.abs(st.median[i12] - B12_TARGET_MIN) / B12_TARGET_MIN +
      2 * Math.max(0, 0.85 - st.reach[i12]) +
      Math.max(0, 240 - st.fireOutMedian) / 240 +
      Math.abs(speed - targetKmh) / targetKmh;
    cands.push({ m, spotP, burnSteps, baseSpread, K, st, speed, score });
    console.log(`  ${m} m/unit spotP ${spotP} burn ${burnSteps}: baseSpread ${baseSpread} (→ ${speed.toFixed(2)} km/h), K ${K}, B12 reached ${(st.reach[i12] * 100).toFixed(0)}% median ${fmtMin(st.median[i12])}, fire out ~${fmtMin(st.fireOutMedian)}  score ${score.toFixed(2)}`);
  }
}
const best = cands.reduce((a, c) => (c.score < a.score ? c : a));
const P: FireParams = { ...base.params, metersPerUnit: best.m, spotP: best.spotP, burnSteps: best.burnSteps, buildingBurnSteps: Math.round(best.burnSteps * 1.6), baseSpread: best.baseSpread, buildingIgniteK: best.K };
console.log(`\nchosen: ${best.m} m/unit, spotP ${best.spotP}, burnSteps ${best.burnSteps} (map ${(1000 * best.m) / 1000} km × ${(620 * best.m) / 1000} km)`);

// Brush clearance: ring cells around one building at a time get fuel 0.15 (irrigated / cleared yard).
const brush: Record<string, number> = {};
const RUNS = 1000;
const ref = mapStats(P, rows, RUNS, 23);
const engRef = makeEngine(P, P.fuel, rows);
base.buildings.forEach((b, bi) => {
  if (b.kind === 'shelter') return;
  const fuel = P.fuel.slice();
  for (const c of engRef.ring[bi]) if (fuel[c] > 0.15 && engRef.owner[c] < 0) fuel[c] = 0.15;
  const st = mapStats(P, rows, RUNS, 23, fuel);
  const pLostBase = ref.reach[bi] * ref.lostGivenExposed[bi];
  const pLostBrush = st.reach[bi] * (st.lostGivenExposed[bi] || 0);
  const drop = pLostBase > 0.02 ? b.baseRisk * Math.max(0, 1 - pLostBrush / pLostBase) : 0;
  brush[String(b.id)] = Math.round(drop * 10) / 10;
});

const etaRuns = 400;
const etas = referenceEtas(P, rows, mulberry32(31337), etaRuns);
const refEta: Record<string, number> = {};
base.buildings.forEach((b, i) => (refEta[String(b.id)] = etas[i]));

const final = mapStats(P, rows, RUNS, 77);
const report = {
  frontSpeedTargetKmh: targetKmh,
  frontSpeedSimKmh: Math.round(best.speed * 100) / 100,
  firstPassHours: passHours,
  mapKm: [(1000 * best.m) / 1000, (620 * best.m) / 1000],
  cellMeters: P.cellSize * best.m,
  fireOutMedianMin: final.fireOutMedian,
  perBuilding: Object.fromEntries(
    base.buildings.map((b, i) => [
      b.name,
      {
        risk: b.baseRisk,
        reachedPct: Math.round(final.reach[i] * 100),
        medianArrivalMin: final.median[i],
        lostIfReachedPct: Number.isNaN(final.lostGivenExposed[i]) ? null : Math.round(final.lostGivenExposed[i] * 100),
        brushRiskDrop: brush[String(b.id)] ?? null,
      },
    ]),
  ),
  scalesTried: cands.map((c) => ({ metersPerUnit: c.m, spotP: c.spotP, burnSteps: c.burnSteps, baseSpread: c.baseSpread, K: c.K, b12MedianMin: c.st.median[i12], b12ReachPct: Math.round(c.st.reach[i12] * 100) })),
};
const cal: Calibration = {
  params: { metersPerUnit: best.m, spotP: best.spotP, burnSteps: best.burnSteps, buildingBurnSteps: Math.round(best.burnSteps * 1.6), baseSpread: best.baseSpread, buildingIgniteK: best.K },
  brushRiskDrop: brush,
  referenceFireEtaMin: refEta,
  report: { calibrationReport: report },
};
writeFileSync(p_('data/out/calibration.json'), JSON.stringify(cal, null, 2) + '\n');
console.log(`fire out ~${fmtMin(final.fireOutMedian)} (median)`);
for (const [name, r] of Object.entries(report.perBuilding)) {
  const x = r as { risk: number; reachedPct: number; medianArrivalMin: number; lostIfReachedPct: number | null; brushRiskDrop: number | null };
  console.log(`  ${name.padEnd(15)} risk ${String(x.risk).padStart(5)}  reached ${String(x.reachedPct).padStart(3)}%  arrival ${fmtMin(x.medianArrivalMin).padStart(6)}  lost-if-reached ${x.lostIfReachedPct ?? '—'}%  brush −${x.brushRiskDrop ?? 0}  refETA ${fmtMin(refEta[String(base.buildings.find((b) => b.name === name)?.id)])}`);
}
console.log('wrote data/out/calibration.json — now run make_seed.ts');
