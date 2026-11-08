// Lantern simulation engine.
//
// PURE functions only: no SpacetimeDB imports, no Date, no Math.random, no I/O, no async.
// The same code runs in three places:
//   1. the scheduled `tick` reducer (live "with Lantern" run; rng = () => ctx.random()),
//   2. `run_baseline` (instant "without Lantern" run; rng = mulberry32(seed)),
//   3. plain Node (tests in spacetimedb/tests, calibration scripts in data/sim).
//
// Row interfaces below mirror the Spacetime tables in LANTERN_SPEC.md §4 field-for-field,
// so the tick reducer can pass table rows straight in (copy them first — rows are readonly).
//
// Model summary (constants live in seed/fire_params.json, calibrated by data/sim/calibrate.ts):
//  - Fire is a 50x31 cellular automaton advanced in fixed sim-minute steps (stepMinutes).
//    A tick advances minutesPerTick sim-minutes, so changing speed never changes fire behaviour.
//  - Burning cell → each unburned neighbour ignites with p = baseSpread · fuel · windFactor.
//  - Embers: burning cells with fuel ≥ spotMinFuel (dry brush, burning buildings) throw a spot
//    fire 2–4 cells downwind. Roads (fuel 0) stop direct spread; only embers cross them.
//  - Buildings are NOT fuel cells. A building is "exposed" while a neighbouring cell burns or
//    an ember lands on it; each exposed step it ignites with p = 1 − (1 − risk/100)^K, K calibrated
//    so a building the fire reaches is lost with probability ≈ risk/100 (the DINS model's output).
//    So a low-risk (prepared) building can survive a fire passing right next to it.
//  - A burning building lights its footprint (which spreads fire and throws embers) and is
//    lost once the footprint burns out. Anyone not out by then is left behind.
//  - Fire ETA per building = median first-exposure time over a small Monte Carlo of the
//    same engine (handles embers and road crossings, which a plain Dijkstra can't).
//  - Evacuation: mobile residents leave at mobilePerMin; residents who need help move only
//    when staff/vans complete a help_person task (live) or at the same raw rate (baseline).

// ───────────────────────────── Row types (mirror Spacetime tables) ─────────────────────────────

export interface SimRow {
  id: number;
  phase: string; // 'prep' | 'fire' | 'ended'
  running: boolean;
  tick: number;
  simMinutes: number;
  minutesPerTick: number;
  budgetLeft: number;
  windDirDeg: number; // direction the wind blows TOWARD, compass degrees (0 = up/north on the map)
  windMph: number;
}

export interface BuildingRow {
  id: number;
  name: string;
  kind: string; // 'senior' | 'apartments' | 'office' | 'homes' | 'shelter'
  x: number;
  y: number;
  w: number;
  h: number;
  residents: number;
  needsHelp: number;
  staff: number;
  vans: number;
  valueUsd: number;
  risk: number;
  baseRisk: number;
  prepared: boolean;
  status: string; // 'ok' | 'behind' | 'evacuating' | 'clear' | 'burning' | 'lost'
  fireEtaMin: number; // -1 if not expected to reach
  evacNeededMin: number;
  evacStarted: boolean;
  peopleOut: number;
  explanation: string;
}

export interface PersonRow {
  id: number;
  name: string;
  buildingId: number;
  floor: number;
  needsHelp: boolean;
  note: string;
  status: string; // 'inside' | 'pinged' | 'safe' | 'cant_move' | 'claimed' | 'out' | 'left_behind'
  pingedAtTick: number;
  replyText: string;
}

export interface TaskRow {
  id: bigint; // 0n for rows created by the sim this step (insert with autoInc)
  kind: string; // 'help_person' | 'van_run' | 'prep_fix'
  buildingId: number;
  personId: number;
  priority: number; // 3 = urgent
  claimedBy: string;
  done: boolean;
  createdTick: number;
}

export interface FixRow {
  id: number;
  buildingId: number;
  name: string;
  costUsd: number;
  riskDrop: number;
  addVans: number;
  approved: boolean;
}

export interface FireCellRow {
  id: number; // y * cols + x
  x: number;
  y: number;
  fuel: number;
  state: number; // 0 unburned, 1 burning, 2 burned
  burnTicks: number; // sim steps this cell has been burning
}

export interface ResultRow {
  scenario: string; // 'with_lantern' | 'without_lantern'
  peopleSafe: number;
  peopleTotal: number;
  buildingsLost: number;
  damageUsd: number;
  claims: number;
}

// ───────────────────────────── Params & seed ─────────────────────────────

export interface WindSample {
  minute: number; // sim-minutes since ignition
  dirDeg: number; // TOWARD, map degrees
  mph: number; // sustained
  gustMph: number; // drives ember spotting
}

export interface FireParams {
  version: number;
  cols: number;
  rows: number;
  cellSize: number; // map units per cell (map is cols*cellSize x rows*cellSize)
  metersPerUnit: number; // map scale used for calibration / display

  stepMinutes: number; // sim-minutes per fire step
  defaultMinutesPerTick: number;

  baseSpread: number;
  windK: number;
  refWindMph: number; // windK applies at this wind speed; scales linearly
  minWindFactor: number;
  diagonalFactor: number;

  spotP: number; // per burning brush cell per step, at gust = refWindMph
  spotMinFuel: number;
  spotMinCells: number;
  spotMaxCells: number; // max ember distance at gust = refWindMph (scales with gusts)
  spotJitterDeg: number;

  burnSteps: number; // how long a vegetation cell burns
  buildingBurnSteps: number; // how long a building burns before it is lost
  buildingIgniteK: number; // p(ignite | exposed step) = 1 - (1 - risk/100)^K  (see igniteProb)

  ignition: number[]; // cell ids lit when the fire phase starts
  wind: WindSample[]; // replay (step function); empty → keep sim.wind*
  fuel: number[]; // cols*rows fuel values (0 road … 1 dry brush)

  etaEveryTicks: number;
  etaRuns: number;
  etaHorizonMin: number;
  etaSmoothing: number; // 0..1 weight on the previous (counted-down) ETA

  autoStartEtaMin: number; // evacuation starts by itself when fire is this close (both scenarios)
  escalateMin: number; // pinged with no reply this long → urgent task
  autoClaimDelayTicks: number; // open tasks are left for humans this many ticks before on-site staff take them
  claimWindowSkipEtaMin?: number; // …except when the fire is this close (default 30): then on-site staff act at once
  autoReplyPerMin: number; // simulated mobile residents answer "I'm safe" at this rate
  silentPersonIds: number[]; // never reply (e.g. Robert K.)

  evacBaseMin: number; // time to organise before assisted moves start
  mobilePerMin: number; // mobile residents leaving per minute per building
  staffRatePerHour: number; // assisted residents per staff member per hour
  vanRatePerHour: number; // assisted residents transported per van per hour
  walkRatePerHour: number; // per staff when there is no van
  outsideHelpPerHour: number; // no staff at all (neighbours / 911)
  mutualAidPerHour: number; // Lantern only: per cleared building with staff, help sent to staffless buildings
  behindMarginMin: number; // an evacuating building is "behind" only if it misses the fire by more than this

  urgentEtaMin: number; // task priority bumps when fire is closer than this
  minRisk: number;
  preparedRiskMax: number;
  prepBudgetUsd: number;

  touchedDamageFrac: number;
  homesUnits: number; // a 'homes' building is this many insurance claims

  maxSimMinutes: number;
  baselineRuns: number; // >1 averages the baseline over fireSeed, fireSeed+1, … (default 1 = the same fire)
  fireSeed: number; // the live fire and the baseline both use this, so the end screen compares the SAME fire

  calibration?: Record<string, unknown>; // provenance only; never read by the sim
}

export interface SeedFix {
  id: number;
  name: string;
  costUsd: number;
  riskDrop: number;
  addVans: number;
}

export interface SeedBuilding {
  id: number;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  residents: number;
  needsHelp: number;
  staff: number;
  vans: number;
  valueUsd: number;
  baseRisk: number;
  referenceFireEtaMin?: number; // median MC arrival from ignition (computed offline)
  explanation?: string;
  features?: Record<string, unknown>;
  fixes: SeedFix[];
}

export interface SeedPerson {
  id: number;
  name: string;
  buildingId: number;
  floor: number;
  needsHelp: boolean;
  note: string;
}

export interface Seed {
  buildings: SeedBuilding[];
  people: SeedPerson[];
  params: FireParams;
}

export interface World {
  sim: SimRow;
  buildings: BuildingRow[];
  people: PersonRow[];
  tasks: TaskRow[];
  cells: FireCellRow[]; // any order; the engine indexes by id
  /**
   * Sim-minute each resident was pinged (person id → minute). Keeps escalation deadlines and evacuation
   * progress exact when the speed changes mid-evacuation. The module persists it in the private
   * engine_state table; if absent, the engine falls back to (tick − pingedAtTick) × minutesPerTick.
   */
  pingedAtMinute?: Record<number, number>;
}

/** Sim-minute a resident was pinged (exact if recorded, else reconstructed from ticks at the current speed). */
function pingMinute(world: World, x: PersonRow): number {
  const m = world.pingedAtMinute?.[x.id];
  if (m !== undefined) return m;
  return world.sim.simMinutes - (world.sim.tick - x.pingedAtTick) * Math.max(1, world.sim.minutesPerTick);
}

export type Rng = () => number;
export type Mode = 'lantern' | 'baseline';
/** A seed (number) gives deterministic per-tick streams — use p.fireSeed in the tick reducer. */
export type RngSource = Rng | number;

interface Streams {
  fire: Rng;
  eta: Rng;
  people: Rng;
}

/** Independent deterministic streams for one tick, so the fire stream is identical in both scenarios. */
export function tickStreams(src: RngSource, tick: number): Streams {
  if (typeof src === 'function') return { fire: src, eta: src, people: src };
  const mix = (k: number) => {
    let h = (Math.imul(src | 0, 0x9e3779b1) ^ Math.imul(tick + 1, 0x85ebca77) ^ k) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    return mulberry32((h ^ (h >>> 16)) >>> 0);
  };
  return { fire: mix(0x51ed27), eta: mix(0x2c1b3a), people: mix(0x7a3f91) };
}

/**
 * Fire randomness for one absolute fire step (step s covers sim-minute s·stepMinutes). Keyed to the step,
 * not the tick, so the same seed gives the same fire whatever minutesPerTick the presenter picks.
 */
export function fireStepStream(seed: number, step: number): Rng {
  let h = (Math.imul(seed | 0, 0x27d4eb2f) ^ Math.imul(step + 1, 0x165667b1) ^ 0x3c6ef372) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return mulberry32((h ^ (h >>> 16)) >>> 0);
}

// ───────────────────────────── Constants ─────────────────────────────

/** On-site staff the simulation dispatches by itself. Humans on /phone use PHONE_STAFF names. */
export const ON_SITE_STAFF = ['Priya', 'Marcus', 'Dana', 'Luis', 'Grace', 'Omar', 'Keiko', 'Ben', 'Rosa', 'Tom'];
export const PHONE_STAFF = ['Alex', 'Sam', 'Jordan', 'Taylor'];
/** claimedBy suffix for tasks taken by simulated on-site staff (humans' claims never have it). */
export const AUTO_SUFFIX = ' · on-site';

const NB_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NB_DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const DEG = Math.PI / 180;

const BSTATE_OK = 0;
const BSTATE_BURNING = 1;
const BSTATE_LOST = 2;

// ───────────────────────────── Small helpers ─────────────────────────────

/** Deterministic PRNG for the baseline / tests (never use Math.random in a reducer). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "1h50m", "45m", "—" for unknown. Handy for event text and the UI. */
export function fmtMin(m: number): string {
  if (!(m >= 0) || !Number.isFinite(m)) return '—';
  const r = Math.round(m);
  if (r < 60) return `${r}m`;
  const h = Math.floor(r / 60);
  const mm = r % 60;
  return `${h}h${mm < 10 ? '0' : ''}${mm}m`;
}

export function windAt(p: FireParams, minute: number, fallback?: { dirDeg: number; mph: number }): WindSample {
  const w = p.wind;
  if (!w || w.length === 0) {
    const d = fallback ?? { dirDeg: 225, mph: p.refWindMph };
    return { minute, dirDeg: d.dirDeg, mph: d.mph, gustMph: d.mph };
  }
  let cur = w[0];
  for (let i = 1; i < w.length; i++) {
    if (w[i].minute <= minute) cur = w[i];
    else break;
  }
  return cur;
}

/** Cells whose centre lies inside a footprint (at least the centre cell). */
export function footprintCellIds(b: { x: number; y: number; w: number; h: number }, p: FireParams): number[] {
  const out: number[] = [];
  const cs = p.cellSize;
  const x0 = Math.max(0, Math.floor(b.x / cs));
  const x1 = Math.min(p.cols - 1, Math.floor((b.x + b.w) / cs));
  const y0 = Math.max(0, Math.floor(b.y / cs));
  const y1 = Math.min(p.rows - 1, Math.floor((b.y + b.h) / cs));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const mx = (cx + 0.5) * cs;
      const my = (cy + 0.5) * cs;
      if (mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) out.push(cy * p.cols + cx);
    }
  }
  if (out.length === 0) {
    const cx = Math.min(p.cols - 1, Math.max(0, Math.floor((b.x + b.w / 2) / cs)));
    const cy = Math.min(p.rows - 1, Math.max(0, Math.floor((b.y + b.h / 2) / cs)));
    out.push(cy * p.cols + cx);
  }
  return out;
}

// ───────────────────────────── Core fire engine (typed arrays) ─────────────────────────────

/** Static per-call context: fuel, building footprints, risks. */
export interface Engine {
  p: FireParams;
  n: number;
  fuel: Float64Array;
  owner: Int32Array; // cell → building index, -1 if none
  bIds: number[]; // building index → building id
  foot: number[][]; // building index → footprint cell ids
  ring: number[][]; // building index → cells touching the footprint
  risk: Float64Array; // building index → risk 0..100
}

/** Mutable fire state. */
export interface FireGrid {
  state: Uint8Array;
  burn: Uint8Array;
  bstate: Uint8Array; // per building index: 0 ok, 1 burning, 2 lost
  burning: number[]; // cell ids currently burning
}

export function makeEngine(p: FireParams, fuel: ArrayLike<number>, buildings: ReadonlyArray<{ id: number; x: number; y: number; w: number; h: number; risk: number }>): Engine {
  const n = p.cols * p.rows;
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = fuel[i] ?? 0;
  const owner = new Int32Array(n).fill(-1);
  const bIds: number[] = [];
  const foot: number[][] = [];
  const ring: number[][] = [];
  const risk = new Float64Array(buildings.length);
  buildings.forEach((b, bi) => {
    bIds.push(b.id);
    risk[bi] = b.risk;
    const cells = footprintCellIds(b, p).filter((c) => owner[c] === -1);
    for (const c of cells) owner[c] = bi;
    foot.push(cells);
  });
  buildings.forEach((_b, bi) => {
    const seen = new Set<number>();
    for (const c of foot[bi]) {
      const cx = c % p.cols;
      const cy = (c - cx) / p.cols;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NB_DX[k];
        const ny = cy + NB_DY[k];
        if (nx < 0 || ny < 0 || nx >= p.cols || ny >= p.rows) continue;
        const j = ny * p.cols + nx;
        if (owner[j] !== bi) seen.add(j);
      }
    }
    ring.push([...seen]);
  });
  return { p, n, fuel: f, owner, bIds, foot, ring, risk };
}

export function cloneGrid(g: FireGrid): FireGrid {
  return { state: g.state.slice(), burn: g.burn.slice(), bstate: g.bstate.slice(), burning: g.burning.slice() };
}

export interface SubstepResult {
  exposed: number[]; // building indices exposed this step (not yet burning)
  ignited: number[]; // building indices that caught fire this step
  lost: number[]; // building indices lost this step
}

/** Advance the fire by one step (stepMinutes of sim time). */
export function fireSubstep(eng: Engine, g: FireGrid, rng: Rng, wind: WindSample): SubstepResult {
  const p = eng.p;
  const cols = p.cols;
  const rows = p.rows;
  const { fuel, owner } = eng;
  const { state, burn, bstate } = g;
  const nb = eng.bIds.length;

  const wx = Math.sin(wind.dirDeg * DEG);
  const wy = -Math.cos(wind.dirDeg * DEG);
  const wm = Math.max(0, wind.mph) / p.refWindMph;
  const wf = new Float64Array(8);
  for (let k = 0; k < 8; k++) {
    const len = Math.hypot(NB_DX[k], NB_DY[k]);
    const cos = (NB_DX[k] * wx + NB_DY[k] * wy) / len;
    const diag = NB_DX[k] !== 0 && NB_DY[k] !== 0;
    wf[k] = Math.max(p.minWindFactor, 1 + p.windK * wm * cos) * (diag ? p.diagonalFactor : 1) * p.baseSpread;
  }
  // Embers: rate and reach both scale with gusts (Eaton's 60–80 mph gusts threw embers far ahead).
  const gm = Math.max(0, wind.gustMph || wind.mph) / p.refWindMph;
  const spotScale = p.spotP * gm;
  const spotMax = Math.max(p.spotMinCells, Math.round(p.spotMaxCells * Math.min(2.5, gm)));
  const spotSpan = spotMax - p.spotMinCells + 1;

  const exposedFlag = new Uint8Array(nb);
  const ignite: number[] = [];
  // Canonical order: random draws must go to the same cells however the steps were batched into ticks.
  g.burning.sort((a, c) => a - c);

  for (let bi = 0; bi < g.burning.length; bi++) {
    const i = g.burning[bi];
    const cx = i % cols;
    const cy = (i - cx) / cols;
    const own = owner[i];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NB_DX[k];
      const ny = cy + NB_DY[k];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      const o = owner[j];
      if (o >= 0) {
        if (o !== own && bstate[o] === BSTATE_OK) exposedFlag[o] = 1;
        continue;
      }
      if (state[j] !== 0) continue;
      const fj = fuel[j];
      if (fj <= 0) continue;
      if (rng() < fj * wf[k]) ignite.push(j);
    }
    const fi = fuel[i];
    if (spotScale > 0 && fi >= p.spotMinFuel && rng() < spotScale * fi) {
      const d = p.spotMinCells + Math.floor(rng() * spotSpan);
      const a = (wind.dirDeg + (rng() * 2 - 1) * p.spotJitterDeg) * DEG;
      const tx = Math.round(cx + d * Math.sin(a));
      const ty = Math.round(cy - d * Math.cos(a));
      if (tx >= 0 && ty >= 0 && tx < cols && ty < rows) {
        const t = ty * cols + tx;
        const o = owner[t];
        if (o >= 0) {
          if (o !== own && bstate[o] === BSTATE_OK) exposedFlag[o] = 1;
        } else if (state[t] === 0 && fuel[t] > 0 && rng() < fuel[t]) {
          ignite.push(t);
        }
      }
    }
  }

  // Age burning cells.
  const next: number[] = [];
  for (const i of g.burning) {
    burn[i] = Math.min(255, burn[i] + 1);
    const lim = owner[i] >= 0 ? p.buildingBurnSteps : p.burnSteps;
    if (burn[i] >= lim) state[i] = 2;
    else next.push(i);
  }
  for (const j of ignite) {
    if (state[j] === 0) {
      state[j] = 1;
      burn[j] = 0;
      next.push(j);
    }
  }

  // Building ignition.
  const exposed: number[] = [];
  const ignited: number[] = [];
  for (let b = 0; b < nb; b++) {
    if (!exposedFlag[b] || bstate[b] !== BSTATE_OK) continue;
    exposed.push(b);
    if (rng() < igniteProb(eng.risk[b], p)) {
      bstate[b] = BSTATE_BURNING;
      ignited.push(b);
      for (const c of eng.foot[b]) {
        if (state[c] === 0) {
          state[c] = 1;
          burn[c] = 0;
          next.push(c);
        }
      }
    }
  }

  // Buildings whose footprint has burned out are lost.
  const lost: number[] = [];
  for (let b = 0; b < nb; b++) {
    if (bstate[b] !== BSTATE_BURNING) continue;
    let done = true;
    for (const c of eng.foot[b]) {
      if (state[c] !== 2) {
        done = false;
        break;
      }
    }
    if (done) {
      bstate[b] = BSTATE_LOST;
      lost.push(b);
    }
  }

  g.burning = next;
  return { exposed, ignited, lost };
}

/**
 * Per exposed step ignition probability. With K = 1 / (typical exposure steps), a building that the
 * fire reaches is lost with probability ≈ risk/100 — the same quantity the DINS model predicts.
 */
export function igniteProb(risk: number, p: FireParams): number {
  const r = Math.min(0.999, Math.max(0, risk / 100));
  return 1 - Math.pow(1 - r, p.buildingIgniteK);
}

/** Fire steps (absolute step indices) whose start minute falls in (fromMin, toMin]. */
function stepRange(p: FireParams, fromMin: number, toMin: number): [number, number] {
  const first = Math.floor(fromMin / p.stepMinutes) + 1;
  const last = Math.floor(toMin / p.stepMinutes);
  return [first, last];
}

/**
 * Monte Carlo fire arrival: for each building, the median sim-minutes (from `nowMin`) until the
 * fire first touches it, over `runs` futures of the same engine. Buildings already burning/lost → 0.
 *  - default (live "fire arrives in"): median over all futures; -1 if most futures never reach it.
 *  - conditionalMinReach > 0 (prep "if a fire like this reaches you"): median over the futures that
 *    do reach it, provided at least that fraction of futures reach it; else -1.
 */
export function mcArrival(eng: Engine, g0: FireGrid, rng: Rng, nowMin: number, runs: number, horizonMin: number, conditionalMinReach = 0): number[] {
  const p = eng.p;
  const nb = eng.bIds.length;
  const samples: number[][] = [];
  for (let b = 0; b < nb; b++) samples.push([]);
  const [first] = stepRange(p, nowMin, nowMin);
  const maxSteps = Math.ceil(horizonMin / p.stepMinutes);
  for (let r = 0; r < runs; r++) {
    const g = cloneGrid(g0);
    const arr = new Float64Array(nb).fill(Infinity);
    let pending = 0;
    for (let b = 0; b < nb; b++) {
      if (g.bstate[b] !== BSTATE_OK) arr[b] = 0;
      else pending++;
    }
    for (let s = 0; s < maxSteps && pending > 0 && g.burning.length > 0; s++) {
      const minute = (first + s) * p.stepMinutes;
      const res = fireSubstep(eng, g, rng, windAt(p, minute));
      const dt = Math.max(0, minute - nowMin);
      for (const b of res.exposed) {
        if (arr[b] === Infinity) {
          arr[b] = dt;
          pending--;
        }
      }
    }
    for (let b = 0; b < nb; b++) samples[b].push(arr[b]);
  }
  return samples.map((all) => {
    const xs = conditionalMinReach > 0 ? all.filter(Number.isFinite) : all;
    if (conditionalMinReach > 0 && xs.length < conditionalMinReach * all.length) return -1;
    if (xs.length === 0) return -1;
    xs.sort((a, b) => a - b);
    const m = xs[Math.floor((xs.length - 1) / 2)];
    return Number.isFinite(m) ? m : -1;
  });
}

// ───────────────────────────── Rows ↔ engine ─────────────────────────────

function cellArrays(world: World, p: FireParams): { fuel: Float64Array; byId: (FireCellRow | undefined)[] } {
  const n = p.cols * p.rows;
  const fuel = new Float64Array(n);
  const byId: (FireCellRow | undefined)[] = new Array(n);
  for (const c of world.cells) {
    if (c.id >= 0 && c.id < n) {
      byId[c.id] = c;
      fuel[c.id] = c.fuel;
    }
  }
  return { fuel, byId };
}

function gridFromRows(byId: (FireCellRow | undefined)[], buildings: BuildingRow[], n: number): FireGrid {
  const state = new Uint8Array(n);
  const burn = new Uint8Array(n);
  const burning: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = byId[i];
    if (!c) continue;
    state[i] = c.state;
    burn[i] = c.burnTicks;
    if (c.state === 1) burning.push(i);
  }
  const bstate = new Uint8Array(buildings.length);
  buildings.forEach((b, bi) => {
    bstate[bi] = b.status === 'lost' ? BSTATE_LOST : b.status === 'burning' ? BSTATE_BURNING : BSTATE_OK;
  });
  return { state, burn, bstate, burning };
}

// ───────────────────────────── Evacuation model ─────────────────────────────

/** Assisted residents per hour this building can move (staff × vans bottleneck). */
export function helpRatePerHour(b: { staff: number; vans: number }, p: FireParams, extraPerHour = 0): number {
  const staffCap = p.staffRatePerHour * b.staff;
  const transport = b.vans > 0 ? p.vanRatePerHour * b.vans : p.walkRatePerHour * b.staff;
  const r = Math.min(staffCap, transport);
  return (r > 0 ? r : p.outsideHelpPerHour) + extraPerHour;
}

function isAccounted(s: string): boolean {
  return s === 'out' || s === 'left_behind';
}

/**
 * Minutes still needed to get everyone out of `b`:
 *   (base if not started) + max(mobile remaining / mobilePerMin, 60 · assisted remaining / helpRate)
 * Building 12 (9 need help, 4 staff, 1 van) → ~3h; with a second van → ~1h35m.
 */
export function evacNeededMin(b: BuildingRow, people: ReadonlyArray<PersonRow>, p: FireParams, extraPerHour = 0): number {
  let mobile = 0;
  let assisted = 0;
  let any = false;
  for (const x of people) {
    if (x.buildingId !== b.id) continue;
    any = true;
    if (isAccounted(x.status)) continue;
    if (x.needsHelp && x.status !== 'safe') assisted++;
    else if (x.status === 'cant_move' || x.status === 'claimed') assisted++;
    else mobile++;
  }
  if (!any) {
    // No person rows (e.g. tests): fall back to the building's counts.
    assisted = Math.max(0, b.needsHelp);
    mobile = Math.max(0, b.residents - b.needsHelp - b.peopleOut);
  }
  if (mobile === 0 && assisted === 0) return 0;
  const base = b.evacStarted ? 0 : p.evacBaseMin;
  const mob = mobile / p.mobilePerMin;
  const help = assisted > 0 ? (60 * assisted) / helpRatePerHour(b, p, extraPerHour) : 0;
  return base + Math.max(mob, help);
}

export function isPrepared(b: BuildingRow, p: FireParams): boolean {
  if (b.kind === 'shelter') return false;
  const evacOk = b.fireEtaMin < 0 || b.evacNeededMin < b.fireEtaMin;
  // Compare the risk as displayed (rounded), so a building shown as "Risk 70" is never also "Prepared".
  return Math.round(b.risk) < p.preparedRiskMax && evacOk;
}

function taskPriority(person: PersonRow, b: BuildingRow, p: FireParams): number {
  if (person.status === 'cant_move' || b.status === 'burning') return 3;
  let pr = person.needsHelp ? 2 : 1;
  if (b.fireEtaMin >= 0 && b.fireEtaMin <= p.urgentEtaMin) pr += 1;
  return Math.min(3, pr);
}

function onSiteName(b: { id: number }, k: number): string {
  return ON_SITE_STAFF[(b.id * 3 + k) % ON_SITE_STAFF.length] + AUTO_SUFFIX;
}

// ───────────────────────────── Step ─────────────────────────────

export interface StepResult {
  sim: SimRow;
  cells: FireCellRow[]; // changed rows → update
  buildings: BuildingRow[]; // changed rows → update
  people: PersonRow[]; // changed rows → update
  tasksUpdated: TaskRow[]; // existing task rows that changed → update by id
  tasksNew: TaskRow[]; // new task rows (id 0n) → insert
  events: string[]; // → event_log
  ended: boolean; // phase just became 'ended' → write result['with_lantern']
}

class Dirty {
  cells = new Set<FireCellRow>();
  buildings = new Set<BuildingRow>();
  people = new Set<PersonRow>();
  tasks = new Set<TaskRow>();
  newTasks: TaskRow[] = [];
  events: string[] = [];
}

export interface StepOptions {
  mode?: Mode;
  etaRuns?: number; // override p.etaRuns (e.g. fewer for fast-forward)
}

/**
 * Advance the live simulation by one tick. Mutates `world` in place and returns what changed.
 * No-op unless sim.phase === 'fire' && sim.running.
 */
export function stepSimulation(world: World, p: FireParams, rngSrc: RngSource, opts: StepOptions = {}): StepResult {
  const mode: Mode = opts.mode ?? 'lantern';
  const sim = world.sim;
  const d = new Dirty();
  if (sim.phase !== 'fire' || !sim.running) return finish(world, d, false);

  const mpt = Math.max(1, Math.round(sim.minutesPerTick));
  const oldMin = sim.simMinutes;
  sim.tick += 1;
  sim.simMinutes = oldMin + mpt;
  const R = tickStreams(rngSrc, sim.tick);

  // 1. Fire.
  const n = p.cols * p.rows;
  const { fuel, byId } = cellArrays(world, p);
  const eng = makeEngine(p, fuel, world.buildings);
  const g = gridFromRows(byId, world.buildings, n);
  const [first, last] = stepRange(p, oldMin, sim.simMinutes);
  const ignitedB = new Set<number>();
  const lostB = new Set<number>();
  for (let s = first; s <= last; s++) {
    // Fire randomness is keyed to the absolute fire step, so the fire is the same at any speed.
    const fireRng = typeof rngSrc === 'number' ? fireStepStream(rngSrc, s) : R.fire;
    const res = fireSubstep(eng, g, fireRng, windAt(p, s * p.stepMinutes, { dirDeg: sim.windDirDeg, mph: sim.windMph }));
    for (const b of res.ignited) ignitedB.add(b);
    for (const b of res.lost) lostB.add(b);
  }
  for (let i = 0; i < n; i++) {
    const c = byId[i];
    if (!c) continue;
    if (c.state !== g.state[i] || c.burnTicks !== g.burn[i]) {
      c.state = g.state[i];
      c.burnTicks = g.burn[i];
      d.cells.add(c);
    }
  }
  const w = windAt(p, sim.simMinutes, { dirDeg: sim.windDirDeg, mph: sim.windMph });
  sim.windDirDeg = w.dirDeg;
  sim.windMph = w.mph;

  const byPerson = new Map<number, PersonRow>();
  const peopleOf = new Map<number, PersonRow[]>();
  for (const x of world.people) {
    byPerson.set(x.id, x);
    const arr = peopleOf.get(x.buildingId);
    if (arr) arr.push(x);
    else peopleOf.set(x.buildingId, [x]);
  }

  world.buildings.forEach((b, bi) => {
    if (ignitedB.has(bi) && b.status !== 'burning' && b.status !== 'lost') {
      b.status = 'burning';
      b.fireEtaMin = 0;
      d.buildings.add(b);
      d.events.push(`${b.name} caught fire`);
    }
    if (lostB.has(bi) && b.status !== 'lost') {
      b.status = 'lost';
      b.fireEtaMin = 0;
      d.buildings.add(b);
      let left = 0;
      for (const x of peopleOf.get(b.id) ?? []) {
        if (x.status !== 'out' && x.status !== 'left_behind') {
          x.status = 'left_behind';
          d.people.add(x);
          left++;
        }
      }
      for (const t of world.tasks) {
        if (t.buildingId === b.id && !t.done) {
          t.done = true;
          d.tasks.add(t);
        }
      }
      d.events.push(left > 0 ? `${b.name} lost — ${left} ${left === 1 ? 'person' : 'people'} left behind` : `${b.name} lost — everyone was already out`);
    }
  });

  // 2. Fire ETAs (Monte Carlo every etaEveryTicks, counted down in between).
  const runs = opts.etaRuns ?? p.etaRuns;
  const recompute = (sim.tick - 1) % Math.max(1, p.etaEveryTicks) === 0 || ignitedB.size > 0;
  if (recompute && runs > 0 && g.burning.length > 0) {
    const eta = mcArrival(eng, g, R.eta, sim.simMinutes, runs, p.etaHorizonMin);
    world.buildings.forEach((b, bi) => {
      let v = eta[bi];
      if (b.status === 'burning' || b.status === 'lost') v = 0;
      else if (v >= 0 && b.fireEtaMin > 0 && p.etaSmoothing > 0) {
        const prev = Math.max(0, b.fireEtaMin - mpt);
        v = p.etaSmoothing * prev + (1 - p.etaSmoothing) * v;
      }
      v = v < 0 ? -1 : Math.round(v);
      if (v !== b.fireEtaMin) {
        b.fireEtaMin = v;
        d.buildings.add(b);
      }
    });
  } else {
    for (const b of world.buildings) {
      if (b.status === 'burning' || b.status === 'lost') continue;
      if (g.burning.length === 0 && b.fireEtaMin !== -1) {
        b.fireEtaMin = -1;
        d.buildings.add(b);
      } else if (b.fireEtaMin > 0) {
        b.fireEtaMin = Math.max(0, b.fireEtaMin - mpt);
        d.buildings.add(b);
      }
    }
  }

  // 3. Evacuation.
  const tasksByPerson = new Map<number, TaskRow[]>();
  for (const t of world.tasks) {
    const arr = tasksByPerson.get(t.personId);
    if (arr) arr.push(t);
    else tasksByPerson.set(t.personId, [t]);
  }
  const silent = new Set(p.silentPersonIds);
  const replyP = 1 - Math.pow(1 - Math.min(1, p.autoReplyPerMin), mpt);
  // Lantern knows which buildings are already clear and sends their staff to buildings with none.
  const aid = mode === 'lantern' ? world.buildings.filter((x) => x.status === 'clear' && x.staff > 0 && x.kind !== 'shelter') : [];
  const extraFor = (b: BuildingRow) => (b.staff === 0 && b.kind !== 'shelter' ? p.mutualAidPerHour * aid.length : 0);

  for (const b of world.buildings) {
    if (b.status === 'lost' || b.kind === 'shelter') continue;
    const ppl = peopleOf.get(b.id) ?? [];
    if (ppl.length === 0) continue;

    if (!b.evacStarted) {
      const near = b.status === 'burning' || (b.fireEtaMin >= 0 && b.fireEtaMin <= p.autoStartEtaMin);
      if (!near) continue;
      startEvacuationRows(world, b, ppl);
      d.buildings.add(b);
      for (const x of ppl) d.people.add(x);
      d.events.push(b.status === 'burning' ? `${b.name} is on fire — evacuation started` : `Fire ${fmtMin(b.fireEtaMin)} from ${b.name} — evacuation started`);
    }

    // Minutes since this building's evacuation started.
    let startMin = Infinity;
    for (const x of ppl) if (x.status !== 'inside') startMin = Math.min(startMin, pingMinute(world, x));
    if (!Number.isFinite(startMin)) startMin = sim.simMinutes;
    const elapsed = Math.max(0, sim.simMinutes - startMin);
    const capacity = (Math.max(0, elapsed - p.evacBaseMin) * helpRatePerHour(b, p, extraFor(b))) / 60;
    const allowedFlow = Math.floor(elapsed * p.mobilePerMin);

    if (mode === 'baseline') {
      // No check-ins, no tasks: mobile people walk out; staff move assisted people at the raw rate,
      // and residents who would never answer are only found after everyone else.
      const mobile = ppl.filter((x) => !x.needsHelp);
      const flowOut = mobile.filter((x) => x.status === 'out').length;
      let k = allowedFlow - flowOut;
      for (const x of mobile) {
        if (k <= 0) break;
        if (x.status === 'out' || x.status === 'left_behind') continue;
        x.status = 'out';
        d.people.add(x);
        k--;
      }
      const assisted = ppl.filter((x) => x.needsHelp).sort((a, c) => Number(silent.has(a.id)) - Number(silent.has(c.id)) || a.id - c.id);
      const helpOut = assisted.filter((x) => x.status === 'out').length;
      let h = Math.floor(capacity) - helpOut;
      for (const x of assisted) {
        if (h <= 0) break;
        if (x.status === 'out' || x.status === 'left_behind') continue;
        x.status = 'out';
        d.people.add(x);
        h--;
      }
    } else {
      // Lantern: simulated residents answer their check-in.
      for (const x of ppl) {
        if (x.status === 'pinged' && !x.needsHelp && !silent.has(x.id) && R.people() < replyP) {
          x.status = 'safe';
          d.people.add(x);
        }
      }
      // Escalate anyone still silent after escalateMin.
      const escalated: PersonRow[] = [];
      for (const x of ppl) {
        if (x.status !== 'pinged') continue;
        if (sim.simMinutes - pingMinute(world, x) < p.escalateMin) continue;
        const existing = tasksByPerson.get(x.id) ?? [];
        if (existing.some((t) => t.kind === 'help_person')) continue;
        const t: TaskRow = { id: 0n, kind: 'help_person', buildingId: b.id, personId: x.id, priority: taskPriority(x, b, p), claimedBy: '', done: false, createdTick: sim.tick };
        world.tasks.push(t);
        d.newTasks.push(t);
        tasksByPerson.set(x.id, [...existing, t]);
        escalated.push(x);
      }
      const who = (x: PersonRow) => `${x.name}${x.note ? ' (' + x.note + ')' : ''}`;
      if (escalated.length <= 2) for (const x of escalated) d.events.push(`Escalated: ${who(x)} — no reply`);
      else d.events.push(`Escalated ${escalated.length} in ${b.name} — no reply: ${escalated.slice(0, 3).map(who).join(', ')} +${escalated.length - 3} more`);
      // Mobile flow: "I'm safe" first, then people who just haven't answered.
      const served = new Set<number>();
      let servedCount = 0;
      for (const x of ppl) {
        for (const t of tasksByPerson.get(x.id) ?? []) {
          if (t.kind === 'help_person' && t.done && t.claimedBy !== '' && x.status === 'out') {
            served.add(x.id);
            servedCount++;
            break;
          }
        }
      }
      const flowOut = ppl.filter((x) => x.status === 'out' && !served.has(x.id)).length;
      let k = allowedFlow - flowOut;
      const flowCands = ppl
        .filter((x) => x.status === 'safe' || (x.status === 'pinged' && !x.needsHelp))
        .sort((a, c) => Number(c.status === 'safe') - Number(a.status === 'safe') || a.id - c.id);
      for (const x of flowCands) {
        if (k <= 0) break;
        x.status = 'out';
        d.people.add(x);
        k--;
        for (const t of tasksByPerson.get(x.id) ?? []) {
          if (!t.done) {
            t.done = true; // left on their own; close the check
            d.tasks.add(t);
          }
        }
        if (x.needsHelp) d.events.push(`${x.name} reached ${shelterName(world)}`);
      }
      // On-site staff: claim → complete, paced by staff/van capacity.
      const bTasks = world.tasks.filter((t) => t.buildingId === b.id && t.kind === 'help_person' && !t.done);
      const inProgress = bTasks.filter((t) => t.claimedBy.endsWith(AUTO_SUFFIX)).sort((a, c) => a.createdTick - c.createdTick);
      let progress = capacity - servedCount;
      if (inProgress.length > 0 && progress >= 1) {
        const t = inProgress.shift() as TaskRow;
        const x = byPerson.get(t.personId);
        t.done = true;
        d.tasks.add(t);
        progress -= 1;
        if (x && x.status !== 'out' && x.status !== 'left_behind') {
          x.status = 'out';
          d.people.add(x);
          d.events.push(`${x.name} reached ${shelterName(world)} with ${t.claimedBy.replace(AUTO_SUFFIX, '')}`);
        }
      }
      if (inProgress.length === 0) {
        // Humans get a claim window — unless the fire is about to reach the building, then nobody waits.
        const fireNear = b.status === 'burning' || (b.fireEtaMin >= 0 && b.fireEtaMin <= (p.claimWindowSkipEtaMin ?? 30));
        const open = bTasks
          .filter((t) => t.claimedBy === '' && (fireNear || sim.tick - t.createdTick >= p.autoClaimDelayTicks))
          .filter((t) => {
            const x = byPerson.get(t.personId);
            return !!x && (x.status === 'cant_move' || (x.status === 'pinged' && x.needsHelp));
          })
          .sort((a, c) => c.priority - a.priority || a.createdTick - c.createdTick || a.personId - c.personId);
        const t = open[0];
        if (t) {
          const served2 = world.tasks.filter((u) => u.buildingId === b.id && u.claimedBy.endsWith(AUTO_SUFFIX)).length;
          t.claimedBy = onSiteName(b.staff === 0 && aid.length > 0 ? aid[0] : b, served2);
          d.tasks.add(t);
          const x = byPerson.get(t.personId);
          if (x) {
            x.status = 'claimed';
            d.people.add(x);
          }
        }
      }
      // Keep open-task priorities current (claimed tasks keep theirs; urgent never drops).
      for (const t of bTasks) {
        if (t.done || t.claimedBy !== '') continue;
        const x = byPerson.get(t.personId);
        if (!x) continue;
        const pr = Math.max(taskPriority(x, b, p), t.priority === 3 && x.status === 'cant_move' ? 3 : 0);
        if (pr !== t.priority) {
          t.priority = pr;
          d.tasks.add(t);
        }
      }
    }
  }

  // 4. Building summaries.
  for (const b of world.buildings) {
    if (updateBuildingDerived(b, peopleOf.get(b.id) ?? [], p, d.events, extraFor(b))) d.buildings.add(b);
  }

  // 5. End?
  const fireOut = g.burning.length === 0;
  let ended = false;
  if (fireOut || sim.simMinutes >= p.maxSimMinutes) {
    sim.phase = 'ended';
    sim.running = false;
    ended = true;
    d.events.push(fireOut ? 'The fire is out' : 'Simulation time limit reached');
  }
  return finish(world, d, ended);
}

function shelterName(world: World): string {
  const s = world.buildings.find((b) => b.kind === 'shelter');
  return s ? s.name : 'the shelter';
}

function finish(world: World, d: Dirty, ended: boolean): StepResult {
  const isNew = new Set(d.newTasks);
  return {
    sim: world.sim,
    cells: [...d.cells],
    buildings: [...d.buildings],
    people: [...d.people],
    tasksUpdated: [...d.tasks].filter((t) => !isNew.has(t) && t.id !== 0n),
    tasksNew: d.newTasks,
    events: d.events,
    ended,
  };
}

/** Recompute peopleOut, evacNeededMin, status. Returns true if anything changed. */
function updateBuildingDerived(b: BuildingRow, ppl: PersonRow[], p: FireParams, events: string[], extraPerHour = 0): boolean {
  const before = `${b.peopleOut}|${b.evacNeededMin}|${b.status}|${b.prepared}`;
  const prevStatus = b.status;
  b.peopleOut = ppl.filter((x) => x.status === 'out').length;
  b.evacNeededMin = Math.round(evacNeededMin(b, ppl, p, extraPerHour));
  if (b.status !== 'burning' && b.status !== 'lost') {
    const allOut = ppl.length > 0 && ppl.every((x) => x.status === 'out');
    if (b.kind === 'shelter' || ppl.length === 0) b.status = 'ok';
    else if (b.evacStarted && allOut) b.status = 'clear';
    else if (b.fireEtaMin >= 0 && b.evacNeededMin > b.fireEtaMin + (b.evacStarted ? p.behindMarginMin : 0)) b.status = 'behind';
    else if (b.evacStarted) b.status = 'evacuating';
    else b.status = 'ok';
    if (b.status !== prevStatus) {
      if (b.status === 'behind') events.push(`${b.name} is behind: fire in ${fmtMin(b.fireEtaMin)}, evacuation needs ${fmtMin(b.evacNeededMin)}`);
      if (b.status === 'clear') events.push(`${b.name} clear — everyone is out`);
    }
  }
  return before !== `${b.peopleOut}|${b.evacNeededMin}|${b.status}|${b.prepared}`;
}

// ───────────────────────────── Actions (call from reducers) ─────────────────────────────

/** Mutates building + its people. Only 'inside' residents are pinged (repliers keep their state). */
function startEvacuationRows(world: World, b: BuildingRow, ppl: PersonRow[]): void {
  b.evacStarted = true;
  if (b.status !== 'burning' && b.status !== 'lost') b.status = 'evacuating';
  for (const x of ppl) {
    if (x.status === 'inside') {
      x.status = 'pinged';
      x.pingedAtTick = world.sim.tick;
      if (world.pingedAtMinute) world.pingedAtMinute[x.id] = world.sim.simMinutes;
    }
  }
}

/**
 * Recompute peopleOut / evacNeededMin / status for one building (or all) right after a reducer changed
 * people or tasks, so screens update before the next tick. Returns the buildings that changed.
 */
export function refreshDerived(world: World, p: FireParams, buildingId?: number): BuildingRow[] {
  const changed: BuildingRow[] = [];
  for (const b of world.buildings) {
    if (buildingId !== undefined && b.id !== buildingId) continue;
    const ppl = world.people.filter((x) => x.buildingId === b.id);
    if (updateBuildingDerived(b, ppl, p, [])) changed.push(b);
  }
  return changed;
}

/**
 * start_evacuation(buildingId): returns changed rows + an event line, or an error string for SenderError.
 */
export function startEvacuation(world: World, buildingId: number, p: FireParams): { error?: string; building?: BuildingRow; people: PersonRow[]; events: string[] } {
  const b = world.buildings.find((x) => x.id === buildingId);
  if (!b) return { error: 'unknown building', people: [], events: [] };
  if (world.sim.phase !== 'fire') return { error: 'evacuations start during the fire phase', people: [], events: [] };
  if (b.evacStarted) return { error: 'evacuation already started', people: [], events: [] };
  if (b.status === 'lost') return { error: 'building already lost', people: [], events: [] };
  const ppl = world.people.filter((x) => x.buildingId === b.id);
  startEvacuationRows(world, b, ppl);
  b.evacNeededMin = Math.round(evacNeededMin(b, ppl, p));
  return { building: b, people: ppl, events: [`Evacuation started: ${b.name} (${ppl.length} residents pinged)`] };
}

/**
 * reply_checkin / set_reply_class. choice: 'safe' | 'cant_move' | 'needs_medical' (treated as cant_move).
 * Returns the person, an optional new urgent task (insert with id 0n; also pushed to world.tasks),
 * any existing tasks bumped to urgent, and an event line. 'unclear' (Gemini) → no change, escalates normally.
 */
export function applyReply(world: World, personId: number, choice: string, _p?: FireParams): { error?: string; person?: PersonRow; task?: TaskRow; tasksUpdated: TaskRow[]; events: string[] } {
  const x = world.people.find((q) => q.id === personId);
  if (!x) return { error: 'unknown person', tasksUpdated: [], events: [] };
  if (x.status === 'out' || x.status === 'left_behind') return { error: 'already resolved', tasksUpdated: [], events: [] };
  const tasks = world.tasks.filter((t) => t.personId === x.id && t.kind === 'help_person' && !t.done);
  if (choice === 'safe') {
    if (x.status === 'claimed') return { person: x, tasksUpdated: [], events: [] }; // staff already on the way
    x.status = 'safe';
    return { person: x, tasksUpdated: [], events: [`${x.name}: "I'm safe"`] };
  }
  if (choice === 'cant_move' || choice === 'needs_medical') {
    if (x.status === 'claimed') return { person: x, tasksUpdated: [], events: [] };
    x.status = 'cant_move';
    const label = choice === 'needs_medical' ? 'needs medical help' : "can't get out";
    if (tasks.length > 0) {
      for (const t of tasks) t.priority = 3;
      return { person: x, tasksUpdated: tasks, events: [`${x.name} ${label} — task is now urgent`] };
    }
    const t: TaskRow = { id: 0n, kind: 'help_person', buildingId: x.buildingId, personId: x.id, priority: 3, claimedBy: '', done: false, createdTick: world.sim.tick };
    world.tasks.push(t);
    return { person: x, task: t, tasksUpdated: [], events: [`${x.name} ${label}${x.note ? ' · ' + x.note : ''} — urgent task created`] };
  }
  if (choice === 'unclear') return { person: x, tasksUpdated: [], events: [`${x.name} replied — unclear, a person will follow up`] };
  return { error: `unknown choice '${choice}'`, tasksUpdated: [], events: [] };
}

/** approve_fix: returns an error string (→ SenderError) or the event line. Mutates sim, building, fix. */
export function applyFix(sim: SimRow, b: BuildingRow, fix: FixRow, people: ReadonlyArray<PersonRow>, p: FireParams): { error?: string; event?: string } {
  if (sim.phase !== 'prep') return { error: 'fixes can only be approved during prep' };
  if (fix.approved) return { error: 'already approved' };
  if (fix.buildingId !== b.id) return { error: 'fix belongs to another building' };
  if (fix.costUsd > sim.budgetLeft + 1e-6) return { error: 'not enough budget left' };
  fix.approved = true;
  sim.budgetLeft -= fix.costUsd;
  b.risk = Math.max(p.minRisk, Math.round((b.risk - fix.riskDrop) * 10) / 10);
  b.vans += fix.addVans;
  b.evacNeededMin = Math.round(evacNeededMin(b, people, p));
  const wasPrepared = b.prepared;
  b.prepared = isPrepared(b, p);
  const parts = [`Approved ${fix.name} for ${b.name} ($${Math.round(fix.costUsd / 1000)}K)`];
  if (fix.riskDrop > 0) parts.push(`risk ${Math.round(b.risk)}`);
  if (fix.addVans > 0) parts.push(`evacuation ${fmtMin(b.evacNeededMin)}`);
  if (b.prepared && !wasPrepared) parts.push('Prepared · better insurance rating');
  return { event: parts.join(' · ') };
}

/** set_phase('fire'): reset the grid, light the ignition cells, start the clock. Mutates world. */
export function startFire(world: World, p: FireParams, rngSrc: RngSource, opts: { etaRuns?: number } = {}): StepResult {
  const d = new Dirty();
  const sim = world.sim;
  sim.phase = 'fire';
  sim.running = true;
  sim.tick = 0;
  sim.simMinutes = 0;
  const w = windAt(p, 0, { dirDeg: sim.windDirDeg, mph: sim.windMph });
  sim.windDirDeg = w.dirDeg;
  sim.windMph = w.mph;
  const ign = new Set(p.ignition);
  for (const c of world.cells) {
    const st = ign.has(c.id) && c.fuel > 0 ? 1 : 0;
    if (c.state !== st || c.burnTicks !== 0) {
      c.state = st;
      c.burnTicks = 0;
      d.cells.add(c);
    }
  }
  const { fuel, byId } = cellArrays(world, p);
  for (const b of world.buildings) if (b.status === 'burning' || b.status === 'lost') b.status = 'ok';
  const eng = makeEngine(p, fuel, world.buildings);
  const g = gridFromRows(byId, world.buildings, p.cols * p.rows);
  const runs = opts.etaRuns ?? Math.max(p.etaRuns, 24);
  const eta = mcArrival(eng, g, tickStreams(rngSrc, 0).eta, 0, runs, p.etaHorizonMin);
  world.buildings.forEach((b, bi) => {
    b.fireEtaMin = eta[bi] < 0 ? -1 : Math.round(eta[bi]);
    d.buildings.add(b);
  });
  const peopleOf = groupPeople(world.people);
  for (const b of world.buildings) updateBuildingDerived(b, peopleOf.get(b.id) ?? [], p, d.events);
  d.events.push(`Fire started — wind ${Math.round(sim.windMph)} mph toward ${compass(sim.windDirDeg)}`);
  return finish(world, d, false);
}

function groupPeople(people: PersonRow[]): Map<number, PersonRow[]> {
  const m = new Map<number, PersonRow[]>();
  for (const x of people) {
    const a = m.get(x.buildingId);
    if (a) a.push(x);
    else m.set(x.buildingId, [x]);
  }
  return m;
}

export function compass(deg: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// ───────────────────────────── Seeding ─────────────────────────────

export interface SeededWorld extends World {
  fixes: FixRow[];
}

/** Rows for every table from the seed files (seed/buildings.json + people.json + fire_params.json). */
export function buildWorldFromSeed(seed: Seed): SeededWorld {
  const p = seed.params;
  const first = windAt(p, 0);
  const sim: SimRow = {
    id: 0,
    phase: 'prep',
    running: false,
    tick: 0,
    simMinutes: 0,
    minutesPerTick: p.defaultMinutesPerTick,
    budgetLeft: p.prepBudgetUsd,
    windDirDeg: first.dirDeg,
    windMph: first.mph,
  };
  const people: PersonRow[] = seed.people.map((x) => ({
    id: x.id,
    name: x.name,
    buildingId: x.buildingId,
    floor: x.floor,
    needsHelp: x.needsHelp,
    note: x.note,
    status: 'inside',
    pingedAtTick: 0,
    replyText: '',
  }));
  const buildings: BuildingRow[] = seed.buildings.map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    residents: b.residents,
    needsHelp: b.needsHelp,
    staff: b.staff,
    vans: b.vans,
    valueUsd: b.valueUsd,
    risk: b.baseRisk,
    baseRisk: b.baseRisk,
    prepared: false,
    status: 'ok',
    fireEtaMin: b.referenceFireEtaMin ?? -1,
    evacNeededMin: 0,
    evacStarted: false,
    peopleOut: 0,
    explanation: b.explanation ?? '',
  }));
  if (seed.buildings.some((b) => b.referenceFireEtaMin === undefined)) {
    const eta = referenceEtas(p, buildings, mulberry32(p.fireSeed), 48);
    buildings.forEach((b, i) => {
      if (seed.buildings[i].referenceFireEtaMin === undefined) b.fireEtaMin = eta[i];
    });
  }
  const peopleOf = groupPeople(people);
  for (const b of buildings) {
    b.evacNeededMin = Math.round(evacNeededMin(b, peopleOf.get(b.id) ?? [], p));
    b.prepared = isPrepared(b, p);
  }
  const fixes: FixRow[] = [];
  for (const b of seed.buildings) {
    for (const f of b.fixes) fixes.push({ id: f.id, buildingId: b.id, name: f.name, costUsd: f.costUsd, riskDrop: f.riskDrop, addVans: f.addVans, approved: false });
  }
  return { sim, buildings, people, tasks: [], cells: freshCells(p), fixes, pingedAtMinute: {} };
}

export function freshCells(p: FireParams): FireCellRow[] {
  const cells: FireCellRow[] = [];
  for (let y = 0; y < p.rows; y++) {
    for (let x = 0; x < p.cols; x++) {
      const id = y * p.cols + x;
      cells.push({ id, x, y, fuel: p.fuel[id] ?? 0, state: 0, burnTicks: 0 });
    }
  }
  return cells;
}

/** Prep-phase ETA: median arrival (minutes from ignition) in the simulated fires that reach the building. */
export function referenceEtas(p: FireParams, buildings: ReadonlyArray<{ id: number; x: number; y: number; w: number; h: number; risk: number }>, rng: Rng, runs: number): number[] {
  const eng = makeEngine(p, p.fuel, buildings);
  const n = p.cols * p.rows;
  const g: FireGrid = { state: new Uint8Array(n), burn: new Uint8Array(n), bstate: new Uint8Array(buildings.length), burning: [] };
  for (const c of p.ignition) {
    if (eng.fuel[c] > 0 && eng.owner[c] < 0) {
      g.state[c] = 1;
      g.burning.push(c);
    }
  }
  return mcArrival(eng, g, rng, 0, runs, p.etaHorizonMin, 0.15).map((v) => (v < 0 ? -1 : Math.round(v)));
}

// ───────────────────────────── Results & baseline ─────────────────────────────

/** End-screen numbers for the current world. */
export function computeResults(world: World, p: FireParams, scenario: string): ResultRow {
  const n = p.cols * p.rows;
  const { fuel, byId } = cellArrays(world, p);
  const eng = makeEngine(p, fuel, world.buildings);
  let lost = 0;
  let damage = 0;
  let claims = 0;
  world.buildings.forEach((b, bi) => {
    const units = b.kind === 'homes' ? p.homesUnits : 1;
    if (b.status === 'lost') {
      lost++;
      damage += b.valueUsd;
      claims += units;
      return;
    }
    const touched = b.status === 'burning' || eng.ring[bi].some((c) => c < n && (byId[c]?.state ?? 0) !== 0);
    if (touched) {
      damage += b.valueUsd * p.touchedDamageFrac;
      claims += units;
    }
  });
  const total = world.people.length;
  const left = world.people.filter((x) => x.status === 'left_behind').length;
  return { scenario, peopleSafe: total - left, peopleTotal: total, buildingsLost: lost, damageUsd: Math.round(damage), claims };
}

/** Run the current world to the end instantly (e.g. an "End & compare" button). Mutates world. */
export function fastForward(world: World, p: FireParams, rngSrc: RngSource, opts: StepOptions = {}): void {
  const o: StepOptions = { ...opts }; // same ETA settings as the live tick, so outcomes match a live run
  for (let i = 0; i < 100000 && world.sim.phase === 'fire'; i++) {
    world.sim.running = true;
    stepSimulation(world, p, rngSrc, o);
  }
}

/**
 * The "without Lantern" run: the SAME fire (same seed, same wind), no fixes, nobody moves until the fire
 * is autoStartEtaMin away, no check-ins / escalation / claims / mutual aid. Pass the same fireSeed the
 * live run used (default p.fireSeed). runs > 1 averages over fireSeed, fireSeed+1, …
 */
export function runBaseline(seed: Seed, opts: { fireSeed?: number; runs?: number; minutesPerTick?: number } = {}): ResultRow {
  const p = seed.params;
  const R = Math.max(1, opts.runs ?? p.baselineRuns ?? 1);
  const s0 = opts.fireSeed ?? p.fireSeed;
  const acc = { peopleSafe: 0, peopleTotal: 0, buildingsLost: 0, damageUsd: 0, claims: 0 };
  for (let r = 0; r < R; r++) {
    const world = buildWorldFromSeed(seed);
    if (opts.minutesPerTick) world.sim.minutesPerTick = opts.minutesPerTick;
    startFire(world, p, s0 + r); // identical settings to the live run: same fire, same ETAs
    fastForward(world, p, s0 + r, { mode: 'baseline' });
    const res = computeResults(world, p, 'without_lantern');
    acc.peopleSafe += res.peopleSafe;
    acc.peopleTotal += res.peopleTotal;
    acc.buildingsLost += res.buildingsLost;
    acc.damageUsd += res.damageUsd;
    acc.claims += res.claims;
  }
  return {
    scenario: 'without_lantern',
    peopleSafe: Math.round(acc.peopleSafe / R),
    peopleTotal: Math.round(acc.peopleTotal / R),
    buildingsLost: Math.round(acc.buildingsLost / R),
    damageUsd: Math.round(acc.damageUsd / R),
    claims: Math.round(acc.claims / R),
  };
}

/**
 * "Lantern recommends": unapproved fixes ranked by expected loss avoided per dollar, greedily within the
 * remaining budget. Expected loss avoided = value × riskDrop/100 for buildings the fire is expected to reach
 * (10% weight otherwise); a van counts as the people it protects (needs-help residents who would not get
 * out before the fire), valued at $1M each for ranking only. Returns fix ids in order.
 */
export function recommendFixes(world: { sim: SimRow; buildings: BuildingRow[]; people: PersonRow[] }, fixes: FixRow[], p: FireParams): number[] {
  const byB = new Map(world.buildings.map((b) => [b.id, b]));
  const scored = fixes
    .filter((f) => !f.approved)
    .map((f) => {
      const b = byB.get(f.buildingId);
      if (!b) return { f, score: 0 };
      const reach = b.fireEtaMin >= 0 ? 1 : 0.1;
      let value = (b.valueUsd * reach * f.riskDrop) / 100;
      if (f.addVans > 0 && b.fireEtaMin >= 0) {
        const ppl = world.people.filter((x) => x.buildingId === b.id);
        const before = evacNeededMin(b, ppl, p);
        const after = evacNeededMin({ ...b, vans: b.vans + f.addVans }, ppl, p);
        if (before > b.fireEtaMin) value += 1_000_000 * b.needsHelp * Math.min(1, (before - Math.max(after, b.fireEtaMin)) / Math.max(1, before - after));
      }
      return { f, score: value / Math.max(1, f.costUsd) };
    })
    .filter((x) => x.score > 0)
    .sort((a, c) => c.score - a.score);
  const out: number[] = [];
  let budget = world.sim.budgetLeft;
  for (const { f } of scored) {
    if (f.costUsd <= budget + 1e-6) {
      out.push(f.id);
      budget -= f.costUsd;
    }
  }
  return out;
}

/** Header counters for the dashboard. */
export function counters(world: World): { peopleOut: number; peopleTotal: number; unaccounted: number; buildingsAtRisk: number } {
  const started = new Set(world.buildings.filter((b) => b.evacStarted).map((b) => b.id));
  let out = 0;
  let unaccounted = 0;
  for (const x of world.people) {
    if (x.status === 'out') out++;
    if (started.has(x.buildingId) && (x.status === 'pinged' || x.status === 'cant_move' || x.status === 'left_behind')) unaccounted++;
  }
  const atRisk = world.buildings.filter((b) => b.status === 'behind' || b.status === 'burning').length;
  return { peopleOut: out, peopleTotal: world.people.length, unaccounted, buildingsAtRisk: atRisk };
}
