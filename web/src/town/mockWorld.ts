// ---------------------------------------------------------------------------------------
// MOCK WORLD — local stand-in for the Spacetime module so the town can be built and
// demoed before the real tables/reducers exist. It follows the rules in LANTERN_SPEC.md
// §4 closely, but the source of truth is spacetimedb/src/sim.ts. Replace useMockWorld()
// with useTable() subscriptions once bindings are generated.
// Risk / value numbers below are placeholders (simulated), except Building 12's risk 82.
// ---------------------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import type { Building, BuildingKind, FireCell, Phase, Sim } from './types';
import { CELL, COLS, ROWS } from './iso';
import { LOTS, inHills, onRoad } from './scene';

const BASE_SPREAD = 0.2; // mock pacing only; real constants come from seed/fire_params.json
const WIND_K = 1.4;
const SPOT_P = 0.02;
const BURN_TICKS = 3;
const BUILDING_BURN_TICKS = 5;
const TICK_MS = 700;

type Seed = [number, string, BuildingKind, number, number, number, number, number, number, number, number, number, number];
// id, name, kind, x, y, w, h, residents, needsHelp, staff, vans, risk, valueUsd
const SEED: Seed[] = [
  [12, 'Building 12', 'senior', 570, 250, 150, 70, 38, 9, 4, 1, 82, 14_000_000],
  [9, 'Building 9', 'senior', 780, 300, 110, 60, 22, 6, 3, 1, 64, 9_000_000],
  [7, 'Building 7', 'apartments', 420, 290, 120, 90, 64, 3, 2, 0, 48, 18_000_000],
  [3, 'Building 3', 'apartments', 170, 270, 140, 80, 80, 4, 2, 0, 35, 21_000_000],
  [15, 'Building 15', 'office', 140, 480, 130, 64, 12, 0, 1, 0, 22, 16_000_000],
  [10, 'Building 10', 'apartments', 800, 470, 130, 70, 30, 2, 1, 0, 41, 11_000_000],
  [20, 'Hillside homes', 'homes', 430, 150, 280, 40, 14, 2, 0, 0, 77, 6_500_000],
  [99, 'Shelter A', 'shelter', 440, 505, 140, 60, 0, 0, 2, 0, 10, 8_000_000],
];

/** Prep fixes from spec §5. riskDrop values are placeholders until A's DINS model fills them. */
export type FixKey = 'van' | 'brush' | 'vents' | 'roof';
export interface Fix { key: FixKey; name: string; cost: number; riskDrop: number; addVans: number }
export const FIXES: Fix[] = [
  { key: 'van', name: 'Second evacuation van', cost: 48_000, riskDrop: 0, addVans: 1 },
  { key: 'brush', name: 'Clear brush to 30 ft', cost: 12_000, riskDrop: 44, addVans: 0 },
  { key: 'vents', name: 'Ember-resistant vents', cost: 9_000, riskDrop: 10, addVans: 0 },
  { key: 'roof', name: 'Class A roof', cost: 140_000, riskDrop: 15, addVans: 0 },
];
/** Reference fire arrival used by the "prepared" rule (Building 12 ≈ 1h50m in the spec). */
export const REFERENCE_ETA_MIN = 120;

function evacNeeded(needsHelp: number, staff: number, vans: number) {
  const rate = 0.5 * staff + 2 * vans;
  return rate > 0 ? 20 + (60 * needsHelp) / rate : needsHelp > 0 ? 600 : 20;
}

function seedBuildings(): Building[] {
  return SEED.map(([id, name, kind, x, y, w, h, residents, needsHelp, staff, vans, risk, valueUsd]) => ({
    id, name, kind, x, y, w, h, residents, needsHelp, staff, vans, valueUsd,
    risk, baseRisk: risk, prepared: false, status: 'ok', fireEtaMin: -1,
    evacNeededMin: evacNeeded(needsHelp, staff, vans), evacStarted: false, peopleOut: 0, explanation: '',
  }));
}

function seedCells(buildings: Building[]): FireCell[] {
  const cells: FireCell[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const mx = x * CELL + CELL / 2;
      const my = y * CELL + CELL / 2;
      let fuel = 0.35;
      if (inHills(mx, my)) fuel = 1.0;
      else if (onRoad(mx, my)) fuel = 0;
      else if (LOTS.some((l) => mx >= l.x && mx < l.x + l.w && my >= l.y && my < l.y + l.h)) fuel = 0.1;
      const b = buildings.find((bb) => mx >= bb.x && mx < bb.x + bb.w && my >= bb.y && my < bb.y + bb.h);
      if (b) fuel = b.kind === 'shelter' ? 0.1 : 0.6;
      cells.push({ id: y * COLS + x, x, y, fuel, state: 0, burnTicks: 0 });
    }
  }
  return cells;
}

function seedSim(): Sim {
  return { phase: 'prep', running: false, tick: 0, simMinutes: 0, minutesPerTick: 2, budgetLeft: 500_000, windDirDeg: 225, windMph: 40 };
}

const NEIGHBORS: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function windFactor(dx: number, dy: number, dirDeg: number) {
  const r = (dirDeg * Math.PI) / 180;
  const wx = Math.sin(r);
  const wy = -Math.cos(r);
  const cos = (dx * wx + dy * wy) / Math.hypot(dx, dy);
  return Math.max(0.15, 1 + WIND_K * cos);
}

function footprintCells(b: Building): number[] {
  const out: number[] = [];
  for (let y = Math.floor(b.y / CELL); y <= Math.floor((b.y + b.h - 1) / CELL); y++)
    for (let x = Math.floor(b.x / CELL); x <= Math.floor((b.x + b.w - 1) / CELL); x++)
      if (x >= 0 && x < COLS && y >= 0 && y < ROWS) out.push(y * COLS + x);
  return out;
}

/** Dijkstra from all burning cells; cost in ticks to reach every cell. */
function fireTicks(cells: FireCell[], dirDeg: number): Float64Array {
  const dist = new Float64Array(cells.length).fill(Infinity);
  const heap: [number, number][] = [];
  const push = (d: number, i: number) => {
    heap.push([d, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  for (const c of cells) if (c.state === 1) { dist[c.id] = 0; push(0, c.id); }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const c = cells[i];
    for (const [dx, dy] of NEIGHBORS) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const n = cells[ny * COLS + nx];
      if (n.fuel <= 0 || n.state === 2) continue;
      const nd = d + 1 / (BASE_SPREAD * n.fuel * windFactor(dx, dy, dirDeg));
      if (nd < dist[n.id]) { dist[n.id] = nd; push(nd, n.id); }
    }
  }
  return dist;
}

/** Mirrors the spec's event_log table (the dashboard's live feed). */
export interface LogEvent { id: number; tick: number; text: string; tone: 'info' | 'good' | 'warn' | 'bad' }

interface World { sim: Sim; buildings: Building[]; cells: FireCell[]; burnCount: Record<number, number>; approved: Record<number, FixKey[]>; events: LogEvent[] }

let eventSeq = 1;
const hm = (m: number) => { const h = Math.floor(m / 60); const r = Math.round(m % 60); return h ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`; };
function log(events: LogEvent[], tick: number, text: string, tone: LogEvent['tone']): LogEvent[] {
  return [{ id: eventSeq++, tick, text, tone }, ...events].slice(0, 40);
}

function freshWorld(): World {
  const buildings = seedBuildings();
  return { sim: seedSim(), buildings, cells: seedCells(buildings), burnCount: {}, approved: {}, events: [] };
}

function step(w: World): World {
  const sim = { ...w.sim, tick: w.sim.tick + 1, simMinutes: w.sim.simMinutes + w.sim.minutesPerTick };
  const cells = w.cells.map((c) => ({ ...c }));
  const ignite: number[] = [];

  for (const c of cells) {
    if (c.state !== 1) continue;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const n = cells[ny * COLS + nx];
      if (n.state !== 0 || n.fuel <= 0) continue;
      if (Math.random() < BASE_SPREAD * n.fuel * windFactor(dx, dy, sim.windDirDeg)) ignite.push(n.id);
    }
    if (c.fuel >= 1 && Math.random() < SPOT_P * (sim.windMph / 40)) {
      const r = (sim.windDirDeg * Math.PI) / 180;
      const dist = 2 + Math.floor(Math.random() * 3);
      const tx = Math.round(c.x + Math.sin(r) * dist);
      const ty = Math.round(c.y - Math.cos(r) * dist);
      if (tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS) ignite.push(ty * COLS + tx);
    }
    c.burnTicks += 1;
    if (c.burnTicks >= BURN_TICKS) c.state = 2;
  }
  for (const id of ignite) {
    const n = cells[id];
    if (n.state === 0 && n.fuel > 0) { n.state = 1; n.burnTicks = 0; }
  }

  const eta = sim.tick % 5 === 0 || sim.tick === 1 ? fireTicks(cells, sim.windDirDeg) : null;
  const burnCount = { ...w.burnCount };
  const buildings = w.buildings.map((b0) => {
    const b = { ...b0 };
    const fp = footprintCells(b);
    if (eta) {
      let m = Infinity;
      for (const i of fp) m = Math.min(m, eta[i]);
      b.fireEtaMin = Number.isFinite(m) ? m * sim.minutesPerTick : -1;
    }
    if (b.kind === 'shelter') return b;
    if (b.status === 'lost' || b.status === 'clear') return b;
    if (b.status === 'burning') {
      burnCount[b.id] = (burnCount[b.id] ?? 0) + 1;
      if (burnCount[b.id] >= BUILDING_BURN_TICKS) b.status = 'lost';
      return b;
    }
    if (fp.some((i) => cells[i].state === 1) && Math.random() < (b.risk / 100) * 0.5) {
      b.status = 'burning';
      for (const i of fp) if (cells[i].state === 0) { cells[i].state = 1; cells[i].burnTicks = 0; }
      return b;
    }
    if (b.evacStarted) {
      const perTick = Math.max(1, Math.round((b.residents * sim.minutesPerTick) / Math.max(10, b.evacNeededMin)));
      b.peopleOut = Math.min(b.residents, b.peopleOut + perTick);
      b.status = b.peopleOut >= b.residents ? 'clear' : 'evacuating';
      return b;
    }
    b.status = b.fireEtaMin >= 0 && b.evacNeededMin > b.fireEtaMin ? 'behind' : 'ok';
    return b;
  });

  let events = w.events;
  for (const b of buildings) {
    const before = w.buildings.find((x) => x.id === b.id)!.status;
    if (before === b.status) continue;
    if (b.status === 'behind') events = log(events, sim.tick, `${b.name} is behind: fire in ${hm(b.fireEtaMin)}, evacuation needs ${hm(b.evacNeededMin)}`, 'warn');
    else if (b.status === 'burning') events = log(events, sim.tick, `${b.name} caught fire`, 'bad');
    else if (b.status === 'lost') events = log(events, sim.tick, `${b.name} was lost${b.residents - b.peopleOut > 0 ? `, ${b.residents - b.peopleOut} still inside` : ''}`, 'bad');
    else if (b.status === 'clear') events = log(events, sim.tick, `${b.name} is clear: everyone is out`, 'good');
  }
  if (!cells.some((c) => c.state === 1)) {
    sim.phase = 'ended';
    sim.running = false;
    events = log(events, sim.tick, 'The fire is out', 'info');
  }
  return { ...w, sim, buildings, cells, burnCount, events };
}

export function useMockWorld() {
  const [world, setWorld] = useState<World>(freshWorld);

  useEffect(() => {
    if (!world.sim.running) return;
    const t = setInterval(() => setWorld((w) => (w.sim.running ? step(w) : w)), TICK_MS);
    return () => clearInterval(t);
  }, [world.sim.running]);

  const setPhase = useCallback((phase: Phase) => {
    setWorld((w) => {
      if (phase === 'prep') {
        // back to prep: reset the fire but keep the fixes the manager already paid for
        const fresh = freshWorld();
        return {
          ...fresh,
          approved: w.approved,
          sim: { ...fresh.sim, budgetLeft: w.sim.budgetLeft },
          buildings: fresh.buildings.map((b) => {
            const old = w.buildings.find((o) => o.id === b.id)!;
            return { ...b, prepared: old.prepared, risk: old.risk, vans: old.vans, evacNeededMin: old.evacNeededMin };
          }),
        };
      }
      if (phase === 'fire') {
        const cells = w.cells.map((c) => ({ ...c }));
        for (const [x, y] of [[48, 1], [49, 1], [48, 2], [47, 0], [49, 0]]) {
          const c = cells[y * COLS + x];
          c.state = 1;
          c.burnTicks = 0;
        }
        return { ...w, cells, sim: { ...w.sim, phase: 'fire', running: true }, events: log(w.events, 0, 'Fire ignited in the hills, wind toward the southwest', 'bad') };
      }
      return { ...w, sim: { ...w.sim, phase } };
    });
  }, []);

  const startEvacuation = useCallback((id: number) => {
    setWorld((w) => {
      const b = w.buildings.find((x) => x.id === id);
      if (!b || b.evacStarted || b.status === 'lost' || b.status === 'burning') return w;
      return {
        ...w,
        buildings: w.buildings.map((x) => (x.id === id ? { ...x, evacStarted: true, status: 'evacuating' } : x)),
        events: log(w.events, w.sim.tick, `Evacuation started at ${b.name}: ${b.residents} residents pinged`, 'info'),
      };
    });
  }, []);

  /** Spec reducer approve_fix: check budget, apply risk drop / extra van, recompute prepared. */
  const approveFix = useCallback((id: number, key: FixKey) => {
    setWorld((w) => {
      const b = w.buildings.find((x) => x.id === id);
      const fix = FIXES.find((f) => f.key === key);
      const list = w.approved[id] ?? [];
      if (!b || !fix || w.sim.phase !== 'prep' || list.includes(key) || w.sim.budgetLeft < fix.cost) return w;
      const vans = b.vans + fix.addVans;
      const risk = Math.max(5, b.risk - fix.riskDrop);
      const evac = evacNeeded(b.needsHelp, b.staff, vans);
      return {
        ...w,
        sim: { ...w.sim, budgetLeft: w.sim.budgetLeft - fix.cost },
        approved: { ...w.approved, [id]: [...list, key] },
        events: log(w.events, 0, `Approved ${fix.name.toLowerCase()} for ${b.name}`, 'good'),
        buildings: w.buildings.map((x) => (x.id === id ? { ...x, vans, risk, evacNeededMin: evac, prepared: risk < 40 && evac < REFERENCE_ETA_MIN } : x)),
      };
    });
  }, []);

  /** Jump ahead n ticks instantly (demo / screenshot helper). */
  const advance = useCallback((n: number) => {
    setWorld((w) => {
      let cur = w;
      for (let i = 0; i < n && cur.sim.phase === 'fire'; i++) cur = step(cur);
      return cur;
    });
  }, []);

  const togglePause = useCallback(() => setWorld((w) => (w.sim.phase === 'fire' ? { ...w, sim: { ...w.sim, running: !w.sim.running } } : w)), []);
  const reset = useCallback(() => setWorld(freshWorld()), []);

  return { ...world, setPhase, startEvacuation, approveFix, togglePause, reset, advance };
}
