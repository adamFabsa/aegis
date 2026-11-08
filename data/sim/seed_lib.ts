// Builds the seed (fuel grid, buildings, people, params) from data/neighborhood.json + data/out/*.json.
// Used by make_seed.ts (writes seed/*.json) and calibrate.ts (tunes constants on the real map).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, footprintCellIds, helpRatePerHour, fmtMin } from '../../spacetimedb/src/sim.ts';
import type { FireParams, Seed, SeedBuilding, SeedPerson, WindSample, SeedFix } from '../../spacetimedb/src/sim.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const p_ = (...xs: string[]) => resolve(ROOT, ...xs);

export function readJson<T>(rel: string, fallback?: T): T {
  const f = p_(rel);
  if (!existsSync(f)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${rel} — run the data pipeline first (see data/README.md)`);
  }
  return JSON.parse(readFileSync(f, 'utf8')) as T;
}

// ───────────── map geometry → fuel ─────────────

type Pt = [number, number];

/** Flatten an SVG path made of M/L/C/Z commands (absolute) into a polygon. */
export function flattenPath(d: string, segs = 16): Pt[] {
  const tok = d.match(/[MLCZ]|-?\d*\.?\d+/gi) ?? [];
  const pts: Pt[] = [];
  let i = 0;
  let cur: Pt = [0, 0];
  let cmd = '';
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[MLCZ]/i.test(tok[i])) cmd = tok[i++].toUpperCase();
    if (cmd === 'M' || cmd === 'L') {
      cur = [num(), num()];
      pts.push(cur);
    } else if (cmd === 'C') {
      const c1: Pt = [num(), num()];
      const c2: Pt = [num(), num()];
      const e: Pt = [num(), num()];
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        const u = 1 - t;
        pts.push([
          u * u * u * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0],
          u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1],
        ]);
      }
      cur = e;
    } else if (cmd === 'Z') {
      break;
    } else {
      i++;
    }
  }
  return pts;
}

export function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Neighborhood {
  map: { width: number; height: number; hillsPath: string; roads: (Rect & { name: string })[]; shelterLotPad: number; ignitionCells: [number, number][] };
  buildings: (Omit<SeedBuilding, 'baseRisk' | 'fixes' | 'referenceFireEtaMin' | 'explanation'> & { floors: number; features: Record<string, unknown> })[];
  fixes: { key: string; name: string; costUsd: number; addVans: number; source: string; changes: Record<string, string> }[];
  prepBudgetUsd: number;
}

export const FUEL = { road: 0, lawn: 0.35, structure: 0.6, brush: 1.0, lot: 0.1 };

export function buildFuel(nb: Neighborhood, cols: number, rows: number, cellSize: number): number[] {
  const hills = flattenPath(nb.map.hillsPath);
  const inRect = (x: number, y: number, r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const shelter = nb.buildings.find((b) => b.kind === 'shelter');
  const pad = nb.map.shelterLotPad;
  const lot = shelter ? { x: shelter.x - pad, y: shelter.y - pad, w: shelter.w + 2 * pad, h: shelter.h + 2 * pad } : null;
  const fuel: number[] = new Array(cols * rows).fill(FUEL.lawn);
  const S = 4; // sub-samples per axis
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let road = 0;
      let hill = 0;
      let lotN = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (cx + (sx + 0.5) / S) * cellSize;
          const y = (cy + (sy + 0.5) / S) * cellSize;
          if (nb.map.roads.some((r) => inRect(x, y, r))) road++;
          else if (pointInPoly(x, y, hills)) hill++;
          if (lot && inRect(x, y, lot)) lotN++;
        }
      }
      const n = S * S;
      const id = cy * cols + cx;
      if (road / n >= 0.5) fuel[id] = FUEL.road;
      else if (lotN / n >= 0.5) fuel[id] = FUEL.lot;
      else if (hill / n >= 0.5) fuel[id] = FUEL.brush;
      else fuel[id] = FUEL.lawn;
    }
  }
  const pseudo = { cols, rows, cellSize } as FireParams;
  for (const b of nb.buildings) for (const c of footprintCellIds(b, pseudo)) fuel[c] = FUEL.structure;
  return fuel;
}

// ───────────── params ─────────────

export function defaultParams(): FireParams {
  return {
    version: 1,
    cols: 50,
    rows: 31,
    cellSize: 20,
    metersPerUnit: 4,
    stepMinutes: 2,
    defaultMinutesPerTick: 2,
    baseSpread: 0.3,
    windK: 1.4,
    refWindMph: 40,
    minWindFactor: 0.15,
    diagonalFactor: 0.75,
    spotP: 0.02,
    spotMinFuel: 0.3, // yards/street trees throw embers too (scaled by fuel)
    spotMinCells: 2,
    spotMaxCells: 4,
    spotJitterDeg: 30,
    burnSteps: 5,
    buildingBurnSteps: 8,
    buildingIgniteK: 0.25,
    ignition: [],
    wind: [],
    fuel: [],
    etaEveryTicks: 5,
    etaRuns: 12,
    etaHorizonMin: 600,
    etaSmoothing: 0.5,
    autoStartEtaMin: 10,
    escalateMin: 10,
    autoClaimDelayTicks: 15,
    claimWindowSkipEtaMin: 30,
    autoReplyPerMin: 0.3,
    silentPersonIds: [],
    evacBaseMin: 10,
    mobilePerMin: 4,
    staffRatePerHour: 3,
    vanRatePerHour: 3.18,
    walkRatePerHour: 1,
    outsideHelpPerHour: 0.5,
    mutualAidPerHour: 2,
    behindMarginMin: 5,
    urgentEtaMin: 60,
    minRisk: 5,
    preparedRiskMax: 70,
    prepBudgetUsd: 500000,
    touchedDamageFrac: 0.3,
    homesUnits: 5,
    maxSimMinutes: 720,
    baselineRuns: 1,
    fireSeed: 20250107,
  };
}

interface WindReplay {
  station: string;
  rotationDeg: number;
  samples: { minute: number; localTime: string; realTowardDeg: number; dirDeg: number; mph: number; gustMph: number }[];
}

// ───────────── people ─────────────

const FIRST = ['Alma', 'Dorothy', 'Henry', 'Grace', 'Walter', 'June', 'Eleanor', 'Frank', 'Lucia', 'Arthur', 'Mei', 'Samuel', 'Ruth', 'Jorge', 'Irene', 'Harold', 'Nadia', 'Kofi', 'Beatriz', 'Leon', 'Aiko', 'Diego', 'Fatima', 'Isaac', 'Chloe', 'Mateo', 'Hana', 'Ethan', 'Zara', 'Noah', 'Sofia', 'Liam', 'Amara', 'Oscar', 'Yuki', 'Elena', 'Kwame', 'Ines', 'Theo', 'Layla', 'Raj', 'Carmen', 'Victor', 'Nora', 'Malik', 'Ava', 'Hugo', 'Leila', 'Caleb', 'Rina', 'Tariq', 'Mila', 'Andre', 'Priscilla', 'Felix', 'Lan', 'Gabriel', 'Esther', 'Omar', 'Vivian'];
const LAST = 'ABCDEFGHJKLMNOPRSTVWYZ';
const ASSIST_NOTES = ['wheelchair', 'walker', 'oxygen', 'limited mobility', 'low vision', 'hearing impaired', 'memory care', 'recent hip surgery', 'bedbound'];
const MOBILE_NOTES = ['Spanish speaker', 'Mandarin speaker', 'Korean speaker', 'has a dog', 'has a cat', 'no car'];

export function generatePeople(nb: Neighborhood): { people: SeedPerson[]; silent: number[] } {
  const rng = mulberry32(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const people: SeedPerson[] = [];
  const silent: number[] = [];
  const used = new Set<string>(['Maria R.', 'Robert K.']);
  for (const b of nb.buildings) {
    if (b.residents === 0) continue;
    const floors = Math.max(1, b.floors);
    for (let i = 1; i <= b.residents; i++) {
      const id = b.id * 100 + i;
      let name = '';
      let needsHelp = i <= b.needsHelp;
      let floor = 1 + Math.floor(rng() * floors);
      let note = '';
      if (b.id === 12 && i === 1) {
        name = 'Maria R.';
        floor = 3;
        note = 'wheelchair';
        needsHelp = true;
      } else if (b.id === 12 && i === 2) {
        name = 'Robert K.';
        floor = 2;
        note = 'oxygen';
        needsHelp = true;
        silent.push(id);
      } else {
        for (let tries = 0; tries < 50; tries++) {
          name = `${pick(FIRST)} ${LAST[Math.floor(rng() * LAST.length)]}.`;
          if (!used.has(name)) break;
        }
        note = needsHelp ? pick(ASSIST_NOTES) : rng() < 0.12 ? pick(MOBILE_NOTES) : '';
        if (!needsHelp && rng() < 0.06) silent.push(id); // phone off / asleep: never answers
      }
      used.add(name);
      if (b.kind === 'homes') floor = 1;
      people.push({ id, name, buildingId: b.id, floor, needsHelp, note });
    }
  }
  return { people, silent };
}

// ───────────── assemble ─────────────

export interface Calibration {
  params?: Partial<FireParams>;
  brushRiskDrop?: Record<string, number>;
  referenceFireEtaMin?: Record<string, number>;
  report?: Record<string, unknown>;
}

interface BuildingRisk {
  [id: string]: {
    name: string;
    baseRisk: number;
    topDrivers: { feature: string; label: string; value: string; safest: string; logitAboveSafest: number }[];
    fixes: Record<string, { applicable: boolean; riskDrop: number | null; riskAfter?: number; source: string }>;
  };
}

export function assembleSeed(opts: { calibration?: Calibration } = {}): Seed & { meta: Record<string, unknown> } {
  const nb = readJson<Neighborhood>('data/neighborhood.json');
  const risk = readJson<BuildingRisk>('data/out/building_risk.json');
  const replay = readJson<WindReplay | null>('data/out/wind_replay.json', null);
  const spread = readJson<Record<string, unknown> | null>('data/out/eaton_spread.json', null);
  const model = readJson<Record<string, unknown> | null>('data/out/risk_model.json', null);
  const cal = opts.calibration ?? readJson<Calibration>('data/out/calibration.json', {});

  const p: FireParams = { ...defaultParams(), ...(cal.params ?? {}) };
  p.prepBudgetUsd = nb.prepBudgetUsd;
  p.fuel = buildFuel(nb, p.cols, p.rows, p.cellSize);
  p.ignition = nb.map.ignitionCells.map(([x, y]) => y * p.cols + x);
  p.wind = replay
    ? replay.samples.map<WindSample>((s) => ({ minute: s.minute, dirDeg: s.dirDeg, mph: s.mph, gustMph: s.gustMph }))
    : [{ minute: 0, dirDeg: 225, mph: 32, gustMph: 60 }];

  const { people, silent } = generatePeople(nb);
  p.silentPersonIds = silent;

  // Building 12 calibration target: 9 assisted residents, 1 van → 3h; second van → ~1h35m.
  // evac = base + 60·9/(vanRate·vans)  ⇒  vanRate = 540 / (180 − base).
  p.vanRatePerHour = Math.round((540 / (180 - p.evacBaseMin)) * 1000) / 1000;

  const buildings: SeedBuilding[] = nb.buildings.map((b) => {
    const r = risk[String(b.id)];
    const baseRisk = r ? r.baseRisk : 50;
    const fixes: SeedFix[] = [];
    nb.fixes.forEach((fx, k) => {
      const fr = r?.fixes?.[fx.key];
      let riskDrop = 0;
      if (fx.key === 'van') {
        if (b.needsHelp === 0 || b.staff === 0 || b.kind === 'shelter') return;
      } else if (fx.source === 'simulation') {
        if (b.kind === 'shelter') return;
        riskDrop = cal.brushRiskDrop?.[String(b.id)] ?? 0;
        if (riskDrop < 0.5) return; // fire rarely reaches it: no measurable effect, don't offer
      } else {
        if (!fr || !fr.applicable || (fr.riskDrop ?? 0) <= 0.5) return;
        riskDrop = fr.riskDrop ?? 0;
      }
      fixes.push({ id: b.id * 10 + k + 1, name: fx.name, costUsd: fx.costUsd, riskDrop: Math.round(riskDrop * 10) / 10, addVans: fx.addVans });
    });
    const drivers = (r?.topDrivers ?? []).filter((d) => d.logitAboveSafest > 0.05).map((d) => `${d.label}: ${d.value.toLowerCase()}`);
    const best = [...fixes].filter((f) => f.riskDrop > 0).sort((a, c) => c.riskDrop - a.riskDrop)[0];
    const explanation =
      b.kind === 'shelter'
        ? `${b.name} is the evacuation destination. Model risk ${Math.round(baseRisk)}.`
        : `Risk ${Math.round(baseRisk)} if an Eaton-like fire reaches it` +
          (drivers.length ? ` — driven by ${drivers.slice(0, 3).join(', ')}.` : '.') +
          (best ? ` Biggest single fix: ${best.name} (−${Math.round(best.riskDrop)}).` : '');
    return {
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
      baseRisk,
      referenceFireEtaMin: cal.referenceFireEtaMin?.[String(b.id)],
      explanation,
      features: { ...b.features, floors: b.floors },
      fixes,
    };
  });
  if (buildings.some((b) => b.referenceFireEtaMin === undefined)) for (const b of buildings) delete b.referenceFireEtaMin;

  p.calibration = {
    note: 'SIMULATED neighbourhood. Fire constants calibrated to the real 2025 Eaton Fire (NASA FIRMS + IEM wind); building risk from CAL FIRE DINS.',
    firms: spread ? { targetFrontSpeedKmh: spread['targetFrontSpeedKmh'], firstPass: spread['firstPass'], ignitionLocal: spread['ignitionLocal'] } : null,
    wind: replay ? { station: replay.station, rotationDeg: replay.rotationDeg } : null,
    riskModel: model ? { nStructuresTrained: model['nStructuresTrained'], nFires: model['nFires'], aucRandomHoldout: model['aucRandomHoldout'], eatonDestroyedRate: model['eatonDestroyedRate'] } : null,
    ...(cal.report ?? {}),
  };

  const b12 = buildings.find((b) => b.id === 12);
  const meta: Record<string, unknown> = {};
  if (b12) {
    const one = p.evacBaseMin + (60 * b12.needsHelp) / helpRatePerHour(b12, p);
    const two = p.evacBaseMin + (60 * b12.needsHelp) / helpRatePerHour({ ...b12, vans: b12.vans + 1 }, p);
    meta.building12Evac = `${fmtMin(one)} → ${fmtMin(two)} with a second van`;
  }
  return { buildings, people, params: p, meta };
}

export function staffRoster(seed: Seed, onSite: string[], phone: string[]): Record<string, unknown> {
  const out: Record<string, string[]> = {};
  for (const b of seed.buildings) {
    if (b.staff === 0) continue;
    out[String(b.id)] = Array.from({ length: b.staff }, (_v, k) => onSite[(b.id * 3 + k) % onSite.length]);
  }
  return { phoneStaff: phone, onSiteByBuilding: out, note: 'Phone users pick a phoneStaff name. On-site staff are simulated; their claims end with " · on-site".' };
}
