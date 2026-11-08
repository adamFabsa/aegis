/**
 * Random scenarios on the same town (the roads and lots are one 3D render; everything else varies):
 *   - wind: the Eaton replay rotated ±30° and scaled 0.8–1.2×
 *   - where the fire starts: a random brush cell upwind of the town, or one picked on the map
 *   - construction of every building (roof, eaves, vents, siding, windows, age), scored by the real CAL FIRE
 *     DINS model (risk_model.ts), so risk, fixes and the insurer checklist all follow from the features
 *   - residents: who needs help, their needs, and who never answers their phone
 *   - fire arrival and reach chance per building: re-simulated (Monte Carlo) for the new world
 * Pure and deterministic: the same scenario number always rebuilds the same world.
 */
import * as S from './sim';
import { RISK_MODEL } from './risk_model';

const FEATURES = ['roof', 'eaves', 'vents', 'siding', 'windows', 'yearBand'] as const;
type Feature = (typeof FEATURES)[number];
export type ModelFeatures = Record<Feature, string>;
const COEF = RISK_MODEL.coefficients as unknown as Record<Feature, Record<string, number>>;

/** CAL FIRE DINS model: P(destroyed | an Eaton-like fire reaches it), 0..100, one decimal. */
export function modelRisk(f: ModelFeatures): number {
  let z: number = RISK_MODEL.intercept;
  for (const k of FEATURES) z += COEF[k][f[k]] ?? 0;
  return Math.round(1000 / (1 + Math.exp(-z))) / 10;
}

/** The features pushing risk up, worst first ("roof: wood/combustible"). */
function drivers(f: ModelFeatures): string[] {
  return FEATURES.map((k) => ({ k, above: (COEF[k][f[k]] ?? 0) - Math.min(...Object.values(COEF[k])) }))
    .filter((d) => d.above > 0.05)
    .sort((a, b) => b.above - a.above)
    .map((d) => `${d.k === 'yearBand' ? 'year built' : d.k}: ${f[d.k].toLowerCase()}`);
}

type Weighted = [string, number][];
const PRIORS: Record<Feature, (kind: string) => Weighted> = {
  roof: (k) => k === 'office'
    ? [['Asphalt', 0.35], ['Tile/Concrete', 0.3], ['Metal', 0.2], ['Fire Resistant', 0.1], ['Wood/Combustible', 0.05]]
    : k === 'homes'
      ? [['Wood/Combustible', 0.35], ['Asphalt', 0.4], ['Tile/Concrete', 0.15], ['Metal', 0.05], ['Fire Resistant', 0.05]]
      : [['Wood/Combustible', 0.25], ['Asphalt', 0.4], ['Tile/Concrete', 0.25], ['Metal', 0.05], ['Fire Resistant', 0.05]],
  eaves: () => [['Unenclosed', 0.55], ['Enclosed', 0.35], ['No Eaves', 0.1]],
  vents: () => [['Coarse mesh (>1/8in)', 0.45], ['Fine mesh (<=1/8in)', 0.25], ['Screened (size unknown)', 0.15], ['Unscreened', 0.1], ['No vents', 0.05]],
  siding: (k) => k === 'office'
    ? [['Stucco/Brick/Cement', 0.55], ['Metal', 0.25], ['Ignition resistant', 0.15], ['Wood/Combustible', 0.05]]
    : [['Wood/Combustible', 0.3], ['Stucco/Brick/Cement', 0.5], ['Ignition resistant', 0.12], ['Metal', 0.08]],
  windows: () => [['Single Pane', 0.5], ['Multi Pane', 0.5]],
  yearBand: (k) => k === 'homes'
    ? [['before 1960', 0.35], ['1960-1989', 0.4], ['1990-2007', 0.15], ['2008+ (WUI code)', 0.1]]
    : [['before 1960', 0.1], ['1960-1989', 0.4], ['1990-2007', 0.3], ['2008+ (WUI code)', 0.2]],
};
const YEARS: Record<string, [number, number]> = { 'before 1960': [1925, 1959], '1960-1989': [1960, 1989], '1990-2007': [1990, 2007], '2008+ (WUI code)': [2008, 2022] };
const ASSIST_NOTES = ['wheelchair', 'walker', 'oxygen', 'limited mobility', 'low vision', 'hearing impaired', 'memory care', 'recent hip surgery', 'bedbound'];
const MOBILE_NOTES = ['Spanish speaker', 'Mandarin speaker', 'Korean speaker', 'has a dog', 'has a cat', 'no car'];
/** Fix catalogue (ids are buildingId·10 + slot, the same slots as the pipeline's seed). */
const FIXES = [
  { slot: 1, key: 'van', name: 'Second evacuation van', costUsd: 48000, addVans: 1 },
  { slot: 2, key: 'brush', name: 'Clear brush to 30 ft', costUsd: 12000, addVans: 0 },
  { slot: 3, key: 'vents', name: 'Ember-resistant vent screens', costUsd: 9000, addVans: 0 },
  { slot: 4, key: 'roof', name: 'Class A roof', costUsd: 140000, addVans: 0 },
] as const;

function pick(rng: S.Rng, options: Weighted): string {
  let r = rng() * options.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of options) if ((r -= w) <= 0) return v;
  return options[options.length - 1][0];
}
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Building with random construction, risk from the model, fixes and the explanation that follow from it. */
function randomBuilding(b: S.SeedBuilding, rng: S.Rng, base: S.Seed): S.SeedBuilding {
  if (b.kind === 'shelter') return { ...b, fixes: [...b.fixes] };
  const f = Object.fromEntries(FEATURES.map((k) => [k, pick(rng, PRIORS[k](b.kind))])) as ModelFeatures;
  const risk = modelRisk(f);
  const needsHelp = b.needsHelp === 0 ? 0 : Math.max(1, Math.min(b.residents, Math.round(b.needsHelp * (0.5 + rng()))));
  const cost = (name: string, fallback: number) => base.buildings.flatMap((x) => x.fixes).find((x) => x.name === name)?.costUsd ?? fallback;
  const fixes: S.SeedFix[] = [];
  for (const fx of FIXES) {
    let riskDrop = 0;
    if (fx.key === 'van') {
      if (needsHelp === 0 || b.staff === 0) continue;
    } else if (fx.key === 'brush') {
      // defensible space depends on where the building sits: the pipeline's fire-sim drop, scaled to the new risk
      const was = b.fixes.find((x) => x.name === fx.name);
      if (!was || b.baseRisk <= 0) continue;
      riskDrop = (was.riskDrop * risk) / b.baseRisk;
    } else {
      const safer = fx.key === 'vents' ? 'Fine mesh (<=1/8in)' : 'Tile/Concrete';
      if (f[fx.key] === safer) continue;
      riskDrop = risk - modelRisk({ ...f, [fx.key]: safer });
    }
    if (fx.key !== 'van' && riskDrop <= 0.5) continue;
    fixes.push({ id: b.id * 10 + fx.slot, name: fx.name, costUsd: cost(fx.name, fx.costUsd), riskDrop: round1(riskDrop), addVans: fx.addVans });
  }
  const best = [...fixes].filter((x) => x.riskDrop > 0).sort((a, c) => c.riskDrop - a.riskDrop)[0];
  const d = drivers(f);
  const [y0, y1] = YEARS[f.yearBand];
  return {
    ...b,
    needsHelp,
    baseRisk: risk,
    features: { ...(b.features ?? {}), roof: f.roof, eaves: f.eaves, vents: f.vents, siding: f.siding, windows: f.windows, yearBuilt: y0 + Math.floor(rng() * (y1 - y0 + 1)) },
    fixes,
    explanation: `Risk ${Math.round(risk)} if an Eaton-like fire reaches it` + (d.length ? ` — driven by ${d.slice(0, 3).join(', ')}.` : '.') + (best ? ` Biggest single fix: ${best.name} (−${Math.round(best.riskDrop)}).` : ''),
  };
}

/** Same residents (names, floors), new needs: who needs help, what help, and who never answers. */
function randomPeople(base: S.Seed, buildings: S.SeedBuilding[], rng: S.Rng): { people: S.SeedPerson[]; silent: number[] } {
  const people: S.SeedPerson[] = [];
  const silent: number[] = [];
  for (const b of buildings) {
    const occ = base.people.filter((x) => x.buildingId === b.id).sort((a, c) => a.id - c.id);
    const order = occ.map((x, i) => ({ i, r: rng() })).sort((a, c) => a.r - c.r).map((x) => x.i);
    const helped = new Set(order.slice(0, b.needsHelp));
    occ.forEach((x, i) => {
      const needsHelp = helped.has(i);
      const note = needsHelp ? ASSIST_NOTES[Math.floor(rng() * ASSIST_NOTES.length)] : rng() < 0.12 ? MOBILE_NOTES[Math.floor(rng() * MOBILE_NOTES.length)] : '';
      if (rng() < (needsHelp ? 0.12 : 0.06)) silent.push(x.id); // phone off / asleep: never answers
      people.push({ ...x, needsHelp, note });
    });
  }
  return { people, silent };
}

function footprintOwner(p: S.FireParams, buildings: S.SeedBuilding[]): Int32Array {
  const owner = new Int32Array(p.cols * p.rows).fill(-1);
  buildings.forEach((b, i) => { for (const c of S.footprintCellIds(b, p)) owner[c] = i; });
  return owner;
}

/** A 2×2 block of burnable, unbuilt cells at (cx, cy); empty if the spot cannot burn. */
function ignitionBlock(p: S.FireParams, owner: Int32Array, cx: number, cy: number): number[] {
  const out: number[] = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= p.cols || y >= p.rows) continue;
    const c = y * p.cols + x;
    if ((p.fuel[c] ?? 0) > 0 && owner[c] < 0) out.push(c);
  }
  return out;
}

/** A random brush cell, away from buildings, on the upwind half of the hills (so the fire heads for town). */
function randomIgnition(p: S.FireParams, buildings: S.SeedBuilding[], rng: S.Rng): number[] {
  const owner = footprintOwner(p, buildings);
  const cs = p.cellSize;
  const town = buildings.reduce((a, b) => [a[0] + (b.x + b.w / 2) / buildings.length, a[1] + (b.y + b.h / 2) / buildings.length], [0, 0]);
  const w = S.windAt(p, 0, { dirDeg: 225, mph: p.refWindMph });
  const wx = Math.sin((w.dirDeg * Math.PI) / 180), wy = -Math.cos((w.dirDeg * Math.PI) / 180);
  const near = (x: number, y: number) => buildings.some((b) => x * cs > b.x - 4 * cs && x * cs < b.x + b.w + 4 * cs && y * cs > b.y - 4 * cs && y * cs < b.y + b.h + 4 * cs);
  const cand: { x: number; y: number; up: number }[] = [];
  for (let y = 0; y < p.rows - 1; y++) for (let x = 0; x < p.cols - 1; x++) {
    if ((p.fuel[y * p.cols + x] ?? 0) < 0.9 || near(x, y)) continue;
    cand.push({ x, y, up: -(((x + 0.5) * cs - town[0]) * wx + ((y + 0.5) * cs - town[1]) * wy) });
  }
  if (!cand.length) return p.ignition;
  cand.sort((a, b) => b.up - a.up);
  const c = cand[Math.floor(rng() * Math.max(1, Math.ceil(cand.length / 2)))];
  const block = ignitionBlock(p, owner, c.x, c.y);
  return block.length ? block : p.ignition;
}

/** Fire arrival (median, as the pipeline's reference ETA) and reach chance per building, re-simulated. */
export function withOutlook(seed: S.Seed, runs = 160): S.Seed {
  const p = seed.params;
  const bs = seed.buildings.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, risk: b.baseRisk }));
  const eta = S.referenceEtas(p, bs, S.mulberry32(p.fireSeed ^ 0x5eed), runs);
  // reach: share of runs whose fire exposes the building within the ETA horizon
  const eng = S.makeEngine(p, p.fuel, bs);
  const n = p.cols * p.rows;
  const g0: S.FireGrid = { state: new Uint8Array(n), burn: new Uint8Array(n), bstate: new Uint8Array(bs.length), burning: [] };
  for (const c of p.ignition) if (eng.fuel[c] > 0 && eng.owner[c] < 0) { g0.state[c] = 1; g0.burning.push(c); }
  const rng = S.mulberry32(p.fireSeed ^ 0xa11);
  const hits = new Array(bs.length).fill(0);
  const steps = Math.ceil(p.etaHorizonMin / p.stepMinutes);
  for (let r = 0; r < runs; r++) {
    const g = S.cloneGrid(g0);
    const seen = new Uint8Array(bs.length);
    for (let s = 0; s < steps && g.burning.length; s++) {
      for (const b of S.fireSubstep(eng, g, rng, S.windAt(p, s * p.stepMinutes)).exposed) seen[b] = 1;
    }
    seen.forEach((v, i) => { hits[i] += v; });
  }
  return {
    ...seed,
    buildings: seed.buildings.map((b, i) => ({ ...b, referenceFireEtaMin: eta[i], reachProbability: Math.round((hits[i] / runs) * 100) / 100 })),
  };
}

/** A whole random scenario from the base (pipeline) seed. */
export function makeScenario(base: S.Seed, n: number): S.Seed {
  const rng = S.mulberry32(Math.imul(n, 2654435761) >>> 0 || 1);
  const rot = Math.round((rng() * 2 - 1) * 30);
  const scale = 0.8 + rng() * 0.4;
  const p: S.FireParams = {
    ...base.params,
    wind: (base.params.wind ?? []).map((w) => ({ ...w, dirDeg: (((w.dirDeg + rot) % 360) + 360) % 360, mph: round1(w.mph * scale), gustMph: round1((w.gustMph || w.mph) * scale) })),
    fireSeed: (Math.imul(n, 7919) + 13) >>> 0,
  };
  const buildings = base.buildings.map((b) => randomBuilding(b, rng, base));
  const { people, silent } = randomPeople(base, buildings, rng);
  p.silentPersonIds = silent;
  p.ignition = randomIgnition(p, buildings, rng);
  return withOutlook({ buildings, people, params: p });
}

/** The current world with the fire starting at map cell (cx, cy). Throws if that spot cannot burn. */
export function withIgnition(cur: S.Seed, cx: number, cy: number): S.Seed {
  const p = cur.params;
  const owner = footprintOwner(p, cur.buildings);
  const x = Math.floor(cx), y = Math.floor(cy);
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= p.cols || yy >= p.rows ? -1 : yy * p.cols + xx);
  const c = at(x, y);
  // the clicked cell itself must burn (not a road), and not be a building or touch one
  let nearBuilding = false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const k = at(x + dx, y + dy); if (k >= 0 && owner[k] >= 0) nearBuilding = true; }
  if (c < 0 || (p.fuel[c] ?? 0) <= 0 || nearBuilding) throw new Error('nothing to burn there: pick grass or brush, not a road or a building');
  const block = ignitionBlock(p, owner, x, y);
  return withOutlook({ ...cur, params: { ...p, ignition: block } });
}
