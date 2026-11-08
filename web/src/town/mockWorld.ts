// ---------------------------------------------------------------------------------------
// MOCK WORLD: local stand-in for the Spacetime module so the town can be built and
// demoed before the real tables/reducers exist. It follows the rules in LANTERN_SPEC.md
// §4 closely, but the source of truth is spacetimedb/src/sim.ts. Replace useMockWorld()
// with useTable() subscriptions once bindings are generated.
// Risk / value numbers below are placeholders (simulated), except Building 12's risk 82.
// ---------------------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Building, BuildingKind, FireCell, Person, Phase, ScenarioResult, Sim, Task } from './types';
import { CELL, COLS, ROWS } from './iso';
import { LOTS, inHills, onRoad, routeLength, unitRoute } from './scene';

const BASE_SPREAD = 0.2; // mock pacing only; real constants come from seed/fire_params.json
const WIND_K = 1.4;
const SPOT_P = 0.02;
const BURN_TICKS = 3;
const BUILDING_BURN_TICKS = 36; // ~25 s: smoke, growing fire, gutted, then it collapses
const GUTTED_AT = 20;
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
    evacNeededMin: evacNeeded(needsHelp, staff, vans), evacStarted: false, peopleOut: 0,
    explanation: explain(kind, risk, residents, needsHelp, staff, vans),
  }));
}

/** Stand-in for the Gemini risk note (the worker replaces it); every number in it comes from the row. */
function explain(kind: BuildingKind, risk: number, residents: number, needsHelp: number, staff: number, vans: number): string {
  if (kind === 'shelter') return 'Concrete community center on a cleared lot: the evacuation destination.';
  const evac = evacNeeded(needsHelp, staff, vans);
  const fire = risk >= 70 ? 'Dry brush runs up to the walls and the eaves are open to embers, so a passing ember storm can ignite it.'
    : risk >= 40 ? 'Some brush and wood fencing within 30 ft give embers a way in.'
      : 'Mostly hard surfaces around it; ember ignition is unlikely.';
  const people = needsHelp > 0
    ? ` ${needsHelp} of ${residents} residents need help moving, with ${staff} staff and ${vans} van${vans === 1 ? '' : 's'}: evacuation takes about ${Math.floor(evac / 60)}h ${String(Math.round(evac % 60)).padStart(2, '0')}m.`
    : ` All ${residents} occupants can walk out on their own in about ${Math.round(evac)} minutes.`;
  return fire + people;
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
export interface LogEvent { id: number; tick: number; text: string; tone: 'info' | 'good' | 'warn' | 'bad'; kind?: 'dispatch' | 'collapse' | 'gutted' }

/** Fire units for the incident-command side (engines protect a building once on scene). */
export interface Unit { id: number; name: string; status: 'ready' | 'enroute' | 'onscene'; targetId: number | null; ticksLeft: number; travelTicks: number }
const seedUnits = (): Unit[] => [
  { id: 1, name: 'Engine 1', status: 'ready', targetId: null, ticksLeft: 0, travelTicks: 0 },
  { id: 2, name: 'Engine 2', status: 'ready', targetId: null, ticksLeft: 0, travelTicks: 0 },
  { id: 3, name: 'Truck 3', status: 'ready', targetId: null, ticksLeft: 0, travelTicks: 0 },
];
export const TICK_SECONDS = 0.7;

interface World {
  sim: Sim; buildings: Building[]; cells: FireCell[]; burnCount: Record<number, number>; approved: Record<number, FixKey[]>; events: LogEvent[]; units: Unit[];
  persons: Person[]; tasks: Task[]; helpCredit: Record<number, number>;
  /** the "without Lantern" run: no fixes, no units, evacuation only when the fire is 10 minutes out, no pings or tasks */
  baseline?: boolean;
  /** one fire per run: the live run and the "without Lantern" baseline draw from the same seed */
  seed: number;
  /** buildings the fire front has already reached (each gets one ignition roll, at its current risk) */
  exposed: Record<number, boolean>;
  results?: { with: ScenarioResult; without: ScenarioResult };
}

let eventSeq = 1;
const hm = (m: number) => { const h = Math.floor(m / 60); const r = Math.round(m % 60); return h ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`; };
function log(events: LogEvent[], tick: number, text: string, tone: LogEvent['tone'], kind?: LogEvent['kind']): LogEvent[] {
  return [{ id: eventSeq++, tick, text, tone, kind }, ...events].slice(0, 40);
}

/** Cells covered by an engine's hoses: the footprint plus a two-cell ring. */
function hoseCells(b: Building): number[] {
  const out: number[] = [];
  for (let y = Math.floor(b.y / CELL) - 2; y <= Math.floor((b.y + b.h - 1) / CELL) + 2; y++)
    for (let x = Math.floor(b.x / CELL) - 2; x <= Math.floor((b.x + b.w - 1) / CELL) + 2; x++)
      if (x >= 0 && x < COLS && y >= 0 && y < ROWS) out.push(y * COLS + x);
  return out;
}

function freshWorld(): World {
  const buildings = seedBuildings();
  return { sim: seedSim(), buildings, cells: seedCells(buildings), burnCount: {}, approved: {}, events: [], units: seedUnits(), persons: seedPersons(buildings), tasks: [], helpCredit: {}, seed: (Math.random() * 2 ** 31) | 0, exposed: {} };
}

// ------------------------------------------------------------------ people, check-ins and staff tasks
const FIRST = ['Maria', 'Robert', 'Linda', 'James', 'Rosa', 'David', 'Mei', 'Carlos', 'Patricia', 'George', 'Aiko', 'Luis', 'Helen', 'Samuel',
  'Grace', 'Tomas', 'Joan', 'Kwame', 'Ruth', 'Daniel', 'Elena', 'Frank', 'Nadia', 'Victor', 'Irene', 'Hector', 'Sofia', 'Walter', 'Ana', 'Ibrahim'];
const LAST = 'RKMTGSNLWBHCPDOVAEFJ';
const NOTES = ['wheelchair', 'walker', 'oxygen', 'hard of hearing', 'Spanish speaker', 'low vision', 'cane', 'memory care'];
const STAFF_NAMES = ['Alex', 'Priya', 'Sam', 'Dana', 'Jordan', 'Kim', 'Luis', 'Tess', 'Omar', 'Bea', 'Noah', 'Ivy'];
const ESCALATE_MIN = 10;
const AUTO_CLAIM_TICKS = 3;

function seedPersons(buildings: Building[]): Person[] {
  const out: Person[] = [];
  let id = 1;
  for (const b of buildings) {
    if (b.kind === 'shelter') continue;
    const floors = b.kind === 'homes' ? 1 : b.kind === 'office' ? 4 : 5;
    for (let i = 0; i < b.residents; i++) {
      const needsHelp = i < b.needsHelp;
      const n = (b.id * 7 + i * 3) % FIRST.length;
      let name = `${FIRST[n]} ${LAST[(b.id + i * 5) % LAST.length]}.`;
      // the demo script's residents in Building 12
      if (b.id === 12 && i === 0) name = 'Maria R.';
      if (b.id === 12 && i === b.needsHelp) name = 'Robert K.';
      const plan: Person['plan'] = name === 'Maria R.' || name === 'Robert K.' ? 'silent' : needsHelp ? (i % 4 === 3 ? 'silent' : 'cant') : (i % 7 === 5 ? 'silent' : 'safe');
      out.push({ id: id++, name, buildingId: b.id, floor: 1 + ((i * 3) % floors), needsHelp, note: needsHelp ? NOTES[(b.id + i) % NOTES.length] : '', status: 'inside', pingedAtTick: 0, replyText: '', plan, replyAt: -1 });
    }
  }
  return out;
}

/** Spec "Unaccounted": pinged with no answer, left behind, or still inside a building the fire is reaching. */
export function unaccounted(persons: Person[], buildings: Building[]): Person[] {
  const threatened = new Set(buildings.filter((b) => b.status === 'behind' || b.status === 'burning').map((b) => b.id));
  return persons.filter((p) => p.status === 'pinged' || p.status === 'left_behind' || (p.status === 'inside' && threatened.has(p.buildingId)));
}

export function staffOf(b: Pick<Building, 'id' | 'staff'>): string[] {
  return Array.from({ length: b.staff }, (_, i) => STAFF_NAMES[(b.id + i * 5) % STAFF_NAMES.length]);
}

let taskSeq = 1;
function newTask(tasks: Task[], p: Person, tick: number): Task[] {
  if (tasks.some((t) => t.personId === p.id && !t.done)) return tasks;
  return [...tasks, { id: taskSeq++, kind: 'help_person', buildingId: p.buildingId, personId: p.id, priority: 3, claimedBy: '', done: false, createdTick: tick }];
}

/** Local stand-in for the Gemini classifier: free text -> safe / can't move. */
function classify(text: string): 'safe' | 'cant' {
  return /can'?t|cannot|help|stuck|trapped|wheelchair|smoke|fall|hurt|oxygen|no puedo|ayuda/i.test(text) ? 'cant' : 'safe';
}

/** One evacuation tick for a building: replies, escalation, staff claims, people walking out. */
function evacTick(w: World, b: Building, persons: Person[], tasks: Task[], credit: Record<number, number>, sim: Sim, events: LogEvent[]) {
  const mine = persons.filter((p) => p.buildingId === b.id);
  const mpt = sim.minutesPerTick;
  if (w.baseline) {
    // no pings, no tasks: mobile residents leave on their own, the rest at the raw staff rate
    // nobody pings, so residents who did not notice (asleep, no phone) never leave on their own
    const mobile = mine.filter((p) => !p.needsHelp && p.status !== 'out' && p.plan !== 'silent');
    for (const p of mobile.slice(0, Math.ceil((mine.length * mpt) / 20))) p.status = 'out';
    credit[b.id] = (credit[b.id] ?? 0) + ((0.5 * b.staff) / 60) * mpt;
    for (const p of mine.filter((q) => q.needsHelp && q.status !== 'out')) {
      if (credit[b.id] < 1) break;
      p.status = 'out';
      credit[b.id] -= 1;
    }
  } else {
    for (const p of mine) {
      if (p.status === 'pinged' && p.replyAt !== undefined && p.replyAt >= 0 && sim.tick >= p.replyAt) {
        p.replyAt = -1;
        if (p.plan === 'cant') { p.status = 'cant_move'; tasks = newTask(tasks, p, sim.tick); }
        else p.status = 'safe';
      }
      if (p.status === 'pinged' && !p.escalated && (sim.tick - p.pingedAtTick) * mpt >= ESCALATE_MIN) {
        p.escalated = true;
        tasks = newTask(tasks, p, sim.tick);
        events = log(events, sim.tick, `Escalated: ${p.name} (no reply), ${b.name} floor ${p.floor}`, 'warn');
      }
    }
    // simulated staff pick up urgent tasks nobody has claimed from a phone
    const busy = new Set(tasks.filter((t) => !t.done && t.claimedBy).map((t) => t.claimedBy));
    for (const t of tasks) {
      if (t.buildingId !== b.id || t.done || t.claimedBy || sim.tick - t.createdTick < AUTO_CLAIM_TICKS) continue;
      const s = staffOf(b).find((n) => !busy.has(n));
      if (!s) break;
      t.claimedBy = s;
      t.auto = true;
      busy.add(s);
      const p = persons.find((q) => q.id === t.personId);
      if (p && p.status !== 'out') p.status = 'claimed';
    }
    // mobile residents who are safe or on their way walk out at a steady rate
    const movers = mine.filter((p) => !p.needsHelp && !p.escalated && (p.status === 'safe' || p.status === 'pinged'));
    for (const p of movers.slice(0, Math.ceil((mine.filter((q) => !q.needsHelp).length * mpt) / 20))) p.status = 'out';
    // staff and vans finish claimed help tasks at the spec's rates
    credit[b.id] = Math.min(2, (credit[b.id] ?? 0) + ((0.5 * b.staff + 2 * b.vans) / 60) * mpt);
    for (;;) {
      const t = tasks.find((x) => x.buildingId === b.id && !x.done && x.auto);
      if (!t || credit[b.id] < 1) break;
      credit[b.id] -= 1;
      t.done = true;
      const p = persons.find((q) => q.id === t.personId);
      if (p) p.status = 'out';
    }
  }
  b.peopleOut = mine.filter((p) => p.status === 'out').length;
  b.status = b.peopleOut >= mine.length ? 'clear' : 'evacuating';
  return { tasks, events };
}

function scoreWorld(w: Pick<World, 'buildings' | 'persons'>): ScenarioResult {
  const list = w.buildings.filter((b) => b.kind !== 'shelter');
  const damaged = list.filter((b) => b.status === 'lost' || b.touched);
  return {
    // everyone who was not left inside a collapsed building made it (out, sheltered in a standing building, or rescued)
    peopleSafe: w.persons.filter((p) => p.status !== 'left_behind').length,
    peopleTotal: w.persons.length,
    buildingsLost: list.filter((b) => b.status === 'lost').length,
    damageUsd: damaged.reduce((s, b) => s + b.valueUsd * (b.status === 'lost' ? 1 : 0.3), 0),
    claims: damaged.length,
  };
}

/** Spec run_baseline: the same fire with no fixes, no units, late evacuation, no escalation or claims. */
function runBaseline(seed: number): ScenarioResult {
  let w: World = { ...freshWorld(), baseline: true, seed };
  w = ignite(w);
  for (let i = 0; i < 900 && w.sim.phase === 'fire'; i++) w = step(w);
  return scoreWorld(w);
}

const IGNITION: [number, number][] = [[48, 1], [49, 1], [48, 2], [47, 0], [49, 0]];
function ignite(w: World): World {
  const cells = w.cells.map((c) => ({ ...c }));
  for (const [x, y] of IGNITION) {
    const c = cells[y * COLS + x];
    if (c && c.fuel > 0) { c.state = 1; c.burnTicks = 0; }
  }
  return { ...w, cells, sim: { ...w.sim, phase: 'fire', running: true }, events: w.baseline ? w.events : log(w.events, 0, 'Fire ignited in the hills, wind toward the southwest', 'bad') };
}

/** Deterministic 0..1 from integers (mulberry32 on a mixed key). */
function hash01(...k: number[]): number {
  let t = k.reduce((a, b) => Math.imul(a ^ b, 0x9e3779b1) >>> 0, 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function step(w: World): World {
  const sim = { ...w.sim, tick: w.sim.tick + 1, simMinutes: w.sim.simMinutes + w.sim.minutesPerTick };
  // every draw is keyed by (seed, tick, cell, neighbour) so the same fire burns the same way in both scenarios
  const rand = (...k: number[]) => hash01(w.seed, sim.tick, ...k);
  const cells = w.cells.map((c) => ({ ...c }));
  const ignite: number[] = [];

  for (const c of cells) {
    if (c.state === 2) { if (c.burnTicks < 60) c.burnTicks += 1; continue; }
    if (c.state !== 1) continue;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const n = cells[ny * COLS + nx];
      if (n.state !== 0 || n.fuel <= 0) continue;
      if (rand(1, c.id, n.id) < BASE_SPREAD * n.fuel * windFactor(dx, dy, sim.windDirDeg)) ignite.push(n.id);
    }
    if (c.fuel >= 1 && rand(2, c.id) < SPOT_P * (sim.windMph / 40)) {
      const r = (sim.windDirDeg * Math.PI) / 180;
      const dist = 2 + Math.floor(rand(3, c.id) * 3);
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

  // fire units: drive, arrive, then keep the cells around their building wet
  let events = w.events;
  const units = w.units.map((u) => ({ ...u }));
  for (const u of units) {
    const tb = w.buildings.find((b) => b.id === u.targetId);
    if (!tb) continue;
    if (tb.status === 'lost') {
      events = log(events, sim.tick, `${u.name} returning to staging: ${tb.name} was lost`, 'info');
      u.status = 'ready';
      u.targetId = null;
      continue;
    }
    if (u.status === 'enroute') {
      u.ticksLeft -= 1;
      if (u.ticksLeft <= 0) {
        u.status = 'onscene';
        events = log(events, sim.tick, `${u.name} on scene at ${tb.name}, water on the building`, 'good');
      }
    }
    if (u.status === 'onscene') {
      for (const i of hoseCells(tb)) {
        const c = cells[i];
        if (c.state === 1) { c.state = 2; c.burnTicks = BURN_TICKS; }
        c.fuel = Math.min(c.fuel, 0.12);
      }
    }
  }
  const protectedIds = new Set(units.filter((u) => u.status === 'onscene').map((u) => u.targetId));

  const eta = sim.tick % 5 === 0 || sim.tick === 1 ? fireTicks(cells, sim.windDirDeg) : null;
  const selfEvac: number[] = [];
  const exposed = { ...w.exposed };
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
    // once the fire is 10 minutes out people leave on their own, with or without Lantern
    if (!b.evacStarted && b.status !== 'burning' && b.fireEtaMin >= 0 && b.fireEtaMin <= 10) {
      b.evacStarted = true;
      selfEvac.push(b.id);
    }
    if (b.status === 'burning' && protectedIds.has(b.id)) {
      // engine on scene: the fire is knocked down instead of spreading through the building
      burnCount[b.id] = Math.max(0, (burnCount[b.id] ?? 0) - 2);
      b.burnProgress = burnCount[b.id] / BUILDING_BURN_TICKS;
      if (burnCount[b.id] < GUTTED_AT) b.damage = 1;
      if (burnCount[b.id] === 0) { b.status = b.evacStarted ? 'evacuating' : 'ok'; b.damage = 0; }
      return b;
    }
    if (b.status === 'burning') {
      // a structure fire keeps burning (and throwing heat at its neighbours) until it is out or collapses
      for (const i of fp) { if (cells[i].state !== 0 || cells[i].fuel > 0) { cells[i].state = 1; cells[i].burnTicks = 0; } }
      burnCount[b.id] = (burnCount[b.id] ?? 0) + 1;
      b.damage = burnCount[b.id] >= GUTTED_AT ? 2 : 1;
      b.burnProgress = burnCount[b.id] / BUILDING_BURN_TICKS;
      if (burnCount[b.id] >= BUILDING_BURN_TICKS) { b.status = 'lost'; b.damage = 3; b.burnProgress = 1; }
      return b;
    }
    // embers reach the building once as the front passes: it catches with probability = its risk (less with an engine there)
    const reached = !exposed[b.id] && fp.some((i) => cells[i].state === 1);
    if (reached) exposed[b.id] = true;
    if (reached && hash01(w.seed, 4, b.id) < (b.risk / 100) * (protectedIds.has(b.id) ? 0.15 : 1)) {
      b.status = 'burning';
      b.touched = true;
      b.damage = 1;
      b.burnProgress = 0;
      for (const i of fp) if (cells[i].state === 0) { cells[i].state = 1; cells[i].burnTicks = 0; }
      return b;
    }
    if (b.evacStarted) return b; // people move in evacTick below
    b.status = b.fireEtaMin >= 0 && b.evacNeededMin > b.fireEtaMin ? 'behind' : 'ok';
    return b;
  });

  // people: check-ins, escalation, staff tasks, walking out; anyone still inside a collapsed building is left behind
  const persons = w.persons.map((p) => (selfEvac.includes(p.buildingId) && p.status === 'inside' && !w.baseline
    ? { ...p, status: 'pinged' as const, pingedAtTick: sim.tick, replyAt: p.plan === 'silent' ? -1 : sim.tick + 1 }
    : { ...p }));
  for (const id of selfEvac) if (!w.baseline) events = log(events, sim.tick, `Fire 10 minutes from ${buildings.find((b) => b.id === id)?.name}: residents leaving on their own, Lantern pinged everyone`, 'warn');
  let tasks = w.tasks.map((t) => ({ ...t }));
  const helpCredit = { ...w.helpCredit };
  for (const b of buildings) {
    if (b.status === 'lost') {
      for (const p of persons) if (p.buildingId === b.id && p.status !== 'out') p.status = 'left_behind';
      for (const t of tasks) if (t.buildingId === b.id) t.done = true;
      continue;
    }
    if (!b.evacStarted || b.status === 'burning' || b.status === 'clear' || b.kind === 'shelter') continue;
    ({ tasks, events } = evacTick(w, b, persons, tasks, helpCredit, sim, events));
  }

  for (const b of buildings) {
    const before = w.buildings.find((x) => x.id === b.id)!.status;
    const beforeDamage = w.buildings.find((x) => x.id === b.id)!.damage ?? 0;
    if (b.status === 'burning' && (b.damage ?? 0) === 2 && beforeDamage < 2) events = log(events, sim.tick, `${b.name}: roof caving in, upper floors gutted`, 'bad', 'gutted');
    if (before === b.status) continue;
    if (b.status === 'behind') events = log(events, sim.tick, `${b.name} is behind: fire in ${hm(b.fireEtaMin)}, evacuation needs ${hm(b.evacNeededMin)}`, 'warn');
    else if (b.status === 'burning') events = log(events, sim.tick, `${b.name} caught fire`, 'bad');
    else if (b.status === 'lost') events = log(events, sim.tick, `${b.name} collapsed${b.residents - b.peopleOut > 0 ? `, ${b.residents - b.peopleOut} still inside` : ''}`, 'bad', 'collapse');
    else if (b.status === 'clear') events = log(events, sim.tick, `${b.name} is clear: everyone is out`, 'good');
  }
  if (!cells.some((c) => c.state === 1) && !buildings.some((b) => b.status === 'burning')) {
    sim.phase = 'ended';
    sim.running = false;
    events = log(events, sim.tick, 'The fire is out', 'info');
  }
  const next: World = { ...w, sim, buildings, cells, burnCount, events, units, persons, tasks, helpCredit, exposed };
  if (sim.phase === 'ended' && !w.baseline) next.results = { with: scoreWorld(next), without: runBaseline(w.seed) };
  return next;
}

export function useMockWorld() {
  const [world, setWorld] = useState<World>(freshWorld);
  /** Spec set_speed: here it scales real time per tick, so the fire and the evacuation stay in step. */
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);

  useEffect(() => {
    if (!world.sim.running) return;
    const t = setInterval(() => setWorld((w) => (w.sim.running ? step(w) : w)), TICK_MS / speed);
    return () => clearInterval(t);
  }, [world.sim.running, speed]);

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
      if (phase === 'fire') return ignite(w);
      return { ...w, sim: { ...w.sim, phase } };
    });
  }, []);

  const startEvacuation = useCallback((id: number) => {
    setWorld((w) => {
      const b = w.buildings.find((x) => x.id === id);
      if (!b || b.evacStarted || b.status === 'lost' || b.status === 'burning') return w;
      // every resident gets a check-in ping; the mock answers for anyone nobody answers for on a phone
      const persons = w.persons.map((p) => (p.buildingId === id && p.status === 'inside'
        ? { ...p, status: 'pinged' as const, pingedAtTick: w.sim.tick, replyAt: p.plan === 'silent' ? -1 : w.sim.tick + 1 + ((p.id * 7) % 4) }
        : p));
      return {
        ...w,
        persons,
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

  /** Send the first free unit to a building (incident command). */
  const dispatchUnit = useCallback((buildingId: number) => {
    setWorld((w) => {
      const b = w.buildings.find((x) => x.id === buildingId);
      const u = w.units.find((x) => x.status === 'ready');
      if (!b || !u || w.sim.phase !== 'fire' || b.status === 'lost' || w.units.some((x) => x.targetId === buildingId)) return w;
      const travel = Math.max(2, Math.ceil(routeLength(unitRoute(b)) / 170));
      return {
        ...w,
        units: w.units.map((x) => (x.id === u.id ? { ...x, status: 'enroute', targetId: buildingId, ticksLeft: travel, travelTicks: travel } : x)),
        events: log(w.events, w.sim.tick, `${u.name} responding to ${b.name}`, 'info', 'dispatch'),
      };
    });
  }, []);

  /** Bring a unit back to staging so it can be sent somewhere else. */
  const releaseUnit = useCallback((unitId: number) => {
    setWorld((w) => ({
      ...w,
      units: w.units.map((x) => (x.id === unitId ? { ...x, status: 'ready', targetId: null, ticksLeft: 0 } : x)),
      events: log(w.events, w.sim.tick, `${w.units.find((x) => x.id === unitId)?.name ?? 'Unit'} back at staging`, 'info'),
    }));
  }, []);

  /** Spec reply_checkin: a resident answers from their phone (free text goes through the classifier). */
  const replyCheckin = useCallback((personId: number, choice: 'safe' | 'cant_move' | 'text', text = '') => {
    setWorld((w) => {
      const p = w.persons.find((x) => x.id === personId);
      if (!p || p.status === 'out' || p.status === 'left_behind') return w;
      const kind = choice === 'text' ? classify(text) : choice === 'safe' ? 'safe' : 'cant';
      const status: Person['status'] = kind === 'safe' ? (p.status === 'claimed' ? 'claimed' : 'safe') : p.status === 'claimed' ? 'claimed' : 'cant_move';
      const said = choice === 'text' ? text : choice === 'safe' ? "I'm safe" : "I can't get out";
      const persons = w.persons.map((x) => (x.id === personId ? { ...x, status, replyText: said, replyAt: -1 } : x));
      const b = w.buildings.find((x) => x.id === p.buildingId);
      let tasks = w.tasks;
      let events = w.events;
      if (kind === 'cant') {
        tasks = newTask(tasks, p, w.sim.tick);
        events = log(events, w.sim.tick, `${p.name} can't get out (${b?.name}, floor ${p.floor}): urgent task created`, 'warn');
      } else events = log(events, w.sim.tick, `${p.name} checked in safe`, 'good');
      return { ...w, persons, tasks, events };
    });
  }, []);

  /** Spec claim_task: atomic, so two staff can never claim the same person. Returns an error message or null. */
  const latest = useRef(world);
  useEffect(() => { latest.current = world; });
  const claimTask = useCallback((taskId: number, staffName: string): string | null => {
    const t0 = latest.current.tasks.find((t) => t.id === taskId);
    if (!t0) return 'Task not found';
    if (t0.claimedBy) return `Already claimed by ${t0.claimedBy}`;
    setWorld((w) => {
      const t = w.tasks.find((x) => x.id === taskId);
      if (!t || t.claimedBy || t.done) return w;
      const p = w.persons.find((x) => x.id === t.personId);
      return {
        ...w,
        tasks: w.tasks.map((x) => (x.id === taskId ? { ...x, claimedBy: staffName, auto: false } : x)),
        persons: w.persons.map((x) => (x.id === t.personId ? { ...x, status: 'claimed' } : x)),
        events: log(w.events, w.sim.tick, `${staffName} is going to ${p?.name ?? 'a resident'}`, 'info'),
      };
    });
    return null;
  }, []);

  /** Spec complete_task: the person is out. */
  const completeTask = useCallback((taskId: number) => {
    setWorld((w) => {
      const t = w.tasks.find((x) => x.id === taskId);
      if (!t || t.done) return w;
      const persons = w.persons.map((x) => (x.id === t.personId ? { ...x, status: 'out' as const } : x));
      const buildings = w.buildings.map((b) => (b.id === t.buildingId ? { ...b, peopleOut: persons.filter((p) => p.buildingId === b.id && p.status === 'out').length } : b));
      return {
        ...w, persons, buildings,
        tasks: w.tasks.map((x) => (x.id === taskId ? { ...x, done: true } : x)),
        events: log(w.events, w.sim.tick, `${t.claimedBy} got ${w.persons.find((p) => p.id === t.personId)?.name} out`, 'good'),
      };
    });
  }, []);

  return { ...world, speed, setSpeed, setPhase, startEvacuation, approveFix, togglePause, reset, advance, dispatchUnit, releaseUnit, replyCheckin, claimTask, completeTask };
}
