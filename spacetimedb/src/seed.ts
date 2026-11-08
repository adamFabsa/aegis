/**
 * Validates and normalizes a world seed before any table is touched (Part C's contract), for A's seed
 * format: `{ buildings, people, params }` exactly as written by data/sim/make_seed.ts
 * (seed/buildings.json + seed/people.json + seed/fire_params.json; also bundled as seed_data.ts).
 * Never trusts serialized game state: dynamic fields are rebuilt by sim.buildWorldFromSeed().
 */
import type { FireParams, Seed, SeedBuilding, SeedFix, SeedPerson, WindSample } from './sim';

type Obj = Record<string, unknown>;
const KINDS = ['senior', 'apartments', 'office', 'homes', 'shelter'];

function object(v: unknown, label: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be an object`);
  return v as Obj;
}
function number(o: Obj, key: string, fallback?: number, min = 0, max = 1e12, integer = false): number {
  const n = o[key] ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`Invalid ${key}`);
  return n;
}
function str(o: Obj, key: string, fallback?: string): string {
  const v = o[key] ?? fallback;
  if (typeof v !== 'string' || v.length > 2000) throw new Error(`Invalid ${key}`);
  return v;
}
function array(v: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Invalid ${label}`);
  return v;
}
function unique(rows: { id: number }[], label: string) {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error(`Duplicate ${label} id`);
}

/** Numeric FireParams fields: [key, min, max, integer]. */
const PARAM_RANGES: [keyof FireParams, number, number, boolean][] = [
  ['version', 0, 1e6, true], ['cols', 1, 200, true], ['rows', 1, 200, true], ['cellSize', 1, 1000, false],
  ['metersPerUnit', 0, 1e4, false], ['stepMinutes', 1, 60, true], ['defaultMinutesPerTick', 1, 60, true],
  ['baseSpread', 0, 5, false], ['windK', 0, 10, false], ['refWindMph', 1, 300, false], ['minWindFactor', 0, 10, false],
  ['diagonalFactor', 0, 5, false], ['spotP', 0, 1, false], ['spotMinFuel', 0, 1, false], ['spotMinCells', 0, 100, true],
  ['spotMaxCells', 0, 100, true], ['spotJitterDeg', 0, 180, false], ['burnSteps', 1, 255, true],
  ['buildingBurnSteps', 1, 255, true], ['buildingIgniteK', 0, 100, false], ['etaEveryTicks', 1, 1000, true],
  ['etaRuns', 0, 200, true], ['etaHorizonMin', 1, 1e5, false], ['etaSmoothing', 0, 1, false],
  ['autoStartEtaMin', 0, 1e4, false], ['escalateMin', 0, 1440, false], ['autoClaimDelayTicks', 0, 1e5, true],
  ['autoReplyPerMin', 0, 1, false], ['evacBaseMin', 0, 1e4, false], ['mobilePerMin', 0.001, 1e4, false],
  ['staffRatePerHour', 0, 1e4, false], ['vanRatePerHour', 0, 1e4, false], ['walkRatePerHour', 0, 1e4, false],
  ['outsideHelpPerHour', 0.001, 1e4, false], ['mutualAidPerHour', 0, 1e4, false], ['behindMarginMin', 0, 1e4, false],
  ['urgentEtaMin', 0, 1e5, false], ['minRisk', 0, 100, false], ['preparedRiskMax', 0, 101, false],
  ['prepBudgetUsd', 0, 1e12, false], ['touchedDamageFrac', 0, 1, false], ['homesUnits', 1, 1000, true],
  ['maxSimMinutes', 1, 1e6, false], ['baselineRuns', 1, 100, true], ['fireSeed', 0, 0xffffffff, true],
];

function parseParams(raw: Obj): FireParams {
  const p = {} as FireParams;
  const set = p as unknown as Obj;
  for (const [key, min, max, integer] of PARAM_RANGES) set[key] = number(raw, key, undefined, min, max, integer);
  p.claimWindowSkipEtaMin = number(raw, 'claimWindowSkipEtaMin', 30, 0, 1e4);
  const n = p.cols * p.rows;
  p.fuel = array(raw.fuel, 'fuel', 40000).map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error('Invalid fuel value');
    return v;
  });
  if (p.fuel.length !== n) throw new Error(`fuel must have cols × rows = ${n} values`);
  p.ignition = array(raw.ignition, 'ignition', n).map((v) => {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= n) throw new Error('Invalid ignition cell');
    return v as number;
  });
  if (!p.ignition.length || p.ignition.some((id) => !(p.fuel[id] > 0))) throw new Error('Ignition cells must have fuel');
  p.wind = array(raw.wind ?? [], 'wind', 10000).map((v): WindSample => {
    const o = object(v, 'wind sample');
    return { minute: number(o, 'minute', undefined, 0, 1e6), dirDeg: number(o, 'dirDeg', undefined, 0, 360), mph: number(o, 'mph', undefined, 0, 300), gustMph: number(o, 'gustMph', undefined, 0, 400) };
  });
  p.silentPersonIds = array(raw.silentPersonIds ?? [], 'silentPersonIds', 100000).map((v) => {
    if (!Number.isInteger(v) || (v as number) < 0) throw new Error('Invalid silent person id');
    return v as number;
  });
  if (raw.calibration && typeof raw.calibration === 'object') p.calibration = raw.calibration as Record<string, unknown>;
  return p;
}

export function parseSeed(json: string): Seed {
  if (json.length > 4_000_000) throw new Error('Seed exceeds 4 MB');
  const root = object(JSON.parse(json), 'seed');
  const params = parseParams(object(root.params ?? root.fireParams, 'params'));
  const mapW = params.cols * params.cellSize;
  const mapH = params.rows * params.cellSize;

  const buildings: SeedBuilding[] = array(root.buildings, 'buildings', 100).map((v) => {
    const o = object(v, 'building');
    const kind = str(o, 'kind');
    if (!KINDS.includes(kind)) throw new Error('Invalid building kind');
    const b: SeedBuilding = {
      id: number(o, 'id', undefined, 1, 0xffffffff, true), name: str(o, 'name'), kind,
      x: number(o, 'x', undefined, 0, mapW), y: number(o, 'y', undefined, 0, mapH),
      w: number(o, 'w', undefined, 1, mapW), h: number(o, 'h', undefined, 1, mapH),
      residents: number(o, 'residents', undefined, 0, 10000, true), needsHelp: number(o, 'needsHelp', undefined, 0, 10000, true),
      staff: number(o, 'staff', undefined, 0, 1000, true), vans: number(o, 'vans', undefined, 0, 1000, true),
      valueUsd: number(o, 'valueUsd'), baseRisk: number(o, 'baseRisk', undefined, 0, 100),
      explanation: str(o, 'explanation', ''),
      fixes: [],
    };
    if (o.referenceFireEtaMin !== undefined) b.referenceFireEtaMin = number(o, 'referenceFireEtaMin', undefined, -1, 1e6);
    if (o.features && typeof o.features === 'object' && !Array.isArray(o.features)) b.features = o.features as Record<string, unknown>;
    if (b.x + b.w > mapW || b.y + b.h > mapH || b.needsHelp > b.residents) throw new Error('Invalid building footprint/occupancy');
    b.fixes = array(o.fixes ?? [], 'fixes', 100).map((fv): SeedFix => {
      const f = object(fv, 'fix');
      return { id: number(f, 'id', undefined, 1, 0xffffffff, true), name: str(f, 'name'), costUsd: number(f, 'costUsd'),
        riskDrop: number(f, 'riskDrop', 0, 0, 100), addVans: number(f, 'addVans', 0, 0, 100, true) };
    });
    return b;
  });
  if (!buildings.length) throw new Error('Seed needs buildings');
  unique(buildings, 'building');
  unique(buildings.flatMap((b) => b.fixes), 'fix');

  const people: SeedPerson[] = array(root.people, 'people', 10000).map((v) => {
    const o = object(v, 'person');
    if (typeof o.needsHelp !== 'boolean') throw new Error('Invalid needsHelp');
    return { id: number(o, 'id', undefined, 1, 0xffffffff, true), name: str(o, 'name'),
      buildingId: number(o, 'buildingId', undefined, 1, 0xffffffff, true), floor: number(o, 'floor', 1, 0, 255, true),
      needsHelp: o.needsHelp, note: str(o, 'note', '') };
  });
  unique(people, 'person');
  const ids = new Set(buildings.map((b) => b.id));
  if (people.some((p) => !ids.has(p.buildingId))) throw new Error('Person references missing building');
  for (const b of buildings) {
    const occupants = people.filter((p) => p.buildingId === b.id);
    if (occupants.length !== b.residents || occupants.filter((p) => p.needsHelp).length !== b.needsHelp)
      throw new Error(`Occupancy mismatch for building ${b.id}`);
  }
  const pids = new Set(people.map((p) => p.id));
  params.silentPersonIds = params.silentPersonIds.filter((id) => pids.has(id));
  return { buildings, people, params };
}
