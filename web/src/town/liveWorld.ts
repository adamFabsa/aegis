// LIVE WORLD: the town rendered from the real SpacetimeDB module (Part C's reducers driving Part A's engine).
// Same shape as useMockWorld(), so every component works unchanged on either.
//
// Server: VITE_SPACETIME_URI / VITE_SPACETIME_DB at build time, or ?server=ws://host:port&db=name in the URL.
// Defaults to the local dev server (ws://127.0.0.1:3000, database "lantern").
import { useMemo, useSyncExternalStore } from 'react';
import { DbConnection } from '../module_bindings';
import type * as Rows from '../module_bindings/types';
import type { Building, BuildingKind, BuildingStatus, FireCell, Person, PersonStatus, Phase, ScenarioResult, Sim, Task } from './types';
import type { LogEvent, Unit } from './mockWorld';
import type { BuildingProfile, ConnectionState, FixView, Measure, ScenarioInfo, WorldApi } from './world';
import { CELL } from './iso';

const q = new URLSearchParams(window.location.search);
const SERVER = q.get('server') ?? import.meta.env.VITE_SPACETIME_URI ?? 'ws://127.0.0.1:3000';
const DATABASE = q.get('db') ?? import.meta.env.VITE_SPACETIME_DB ?? 'lantern';
const TOKEN_KEY = `lantern-token:${SERVER}/${DATABASE}`;
/** seed/fire_params.json buildingBurnSteps: how long a structure burns before it is lost (engine steps). */
const BUILDING_BURN_STEPS = 19;
/** B's Town draws burned cells cooling from embers to ash while burnTicks < 3 + 7 (mock semantics). */
const COOL_FROM = 3;
const AUTO_SUFFIX = ' · on-site';
const FIX_NAMES: Record<string, string> = { van: 'Second evacuation van', brush: 'Clear brush to 30 ft', vents: 'Ember-resistant vent screens', roof: 'Class A roof' };

interface Snapshot {
  sim: Sim;
  buildings: Building[];
  cells: FireCell[];
  persons: Person[];
  tasks: Task[];
  events: LogEvent[];
  approved: Record<number, string[]>;
  fixes: Rows.Fix[];
  results?: { with: ScenarioResult; without: ScenarioResult };
  connection: ConnectionState;
  profiles: Map<number, BuildingProfile>;
  checklists: Map<number, Measure[]>;
  devices: number;
  workerOnline: boolean;
  units: Unit[];
  scenario?: ScenarioInfo;
}

const EMPTY_SIM: Sim = { phase: 'prep', running: false, tick: 0, simMinutes: 0, minutesPerTick: 2, budgetLeft: 0, windDirDeg: 225, windMph: 0 };

/** Feed line → tone (colour + alert sound) and kind (siren / crash sounds), from the engine's wording. */
function classify(text: string): Pick<LogEvent, 'tone' | 'kind'> {
  // engines first: "returning to staging: Building 9 was lost" is not itself a collapse
  if (/responding to|sent ahead of the fire/i.test(text)) return { tone: 'info', kind: 'dispatch' };
  if (/on scene at/i.test(text)) return { tone: 'good' };
  if (/staging/i.test(text)) return { tone: 'info' };
  if (/\blost\b|collapsed/i.test(text)) return { tone: 'bad', kind: 'collapse' };
  if (/caught fire|is on fire|Fire started|left behind/i.test(text)) return { tone: 'bad' };
  if (/behind|Escalated|can.t get out|needs medical|unclear/i.test(text)) return { tone: 'warn' };
  if (/clear|reached|safe|Prepared|Approved|is out|complete/i.test(text)) return { tone: 'good' };
  return { tone: 'info' };
}

/** Cells whose centre lies inside the footprint (the engine's rule), plus the ring around it. */
function footprint(b: Rows.Building): { inside: number[]; ring: number[] } {
  const inside: number[] = [];
  const ring: number[] = [];
  const x0 = Math.floor(b.x / CELL) - 1, x1 = Math.floor((b.x + b.w) / CELL) + 1;
  const y0 = Math.floor(b.y / CELL) - 1, y1 = Math.floor((b.y + b.h) / CELL) + 1;
  for (let cy = Math.max(0, y0); cy <= y1; cy++) {
    for (let cx = Math.max(0, x0); cx <= x1; cx++) {
      const mx = (cx + 0.5) * CELL, my = (cy + 0.5) * CELL;
      const id = cy * 50 + cx;
      if (mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) inside.push(id);
      else if (mx >= b.x - CELL && mx < b.x + b.w + CELL && my >= b.y - CELL && my < b.y + b.h + CELL) ring.push(id);
    }
  }
  return { inside, ring };
}

class LiveStore {
  private conn?: DbConnection;
  private listeners = new Set<() => void>();
  private pending = false;
  private burnedAt = new Map<number, number>(); // cell id → sim tick it burned out (client-side, for the cooling animation)
  private footprints = new Map<number, { key: string; inside: number[]; ring: number[] }>();
  private resolveReady!: (c: DbConnection) => void;
  readonly ready = new Promise<DbConnection>((r) => { this.resolveReady = r; });
  snapshot: Snapshot = { sim: EMPTY_SIM, buildings: [], cells: [], persons: [], tasks: [], events: [], approved: {}, fixes: [], connection: { state: 'connecting', server: `${SERVER} / ${DATABASE}` }, profiles: new Map(), checklists: new Map(), devices: 0, workerOnline: false, units: [] };

  connect() {
    if (this.conn) return;
    let token: string | undefined;
    try { token = localStorage.getItem(TOKEN_KEY) ?? undefined; } catch { /* private mode */ }
    this.conn = DbConnection.builder()
      .withUri(SERVER)
      .withDatabaseName(DATABASE)
      .withToken(token)
      .onConnect((c, _identity, newToken) => {
        // Keep the identity: only the staff member (identity) who claimed a task may complete it.
        try { localStorage.setItem(TOKEN_KEY, newToken); } catch { /* ignore */ }
        this.watch(c);
        c.subscriptionBuilder()
          .onApplied(() => {
            for (const cell of c.db.fireCell.iter()) if (cell.state === 2) this.burnedAt.set(cell.id, -1000);
            this.setConnection({ state: 'live', server: `${SERVER} / ${DATABASE}` });
            this.resolveReady(c);
            this.rebuild();
          })
          .onError((ctx) => this.setConnection({ state: 'error', server: `${SERVER} / ${DATABASE}`, message: String((ctx as { event?: unknown }).event ?? 'subscription failed') }))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => this.setConnection({ state: 'error', server: `${SERVER} / ${DATABASE}`, message: err.message }))
      .onDisconnect((_ctx, err) => this.setConnection({ state: 'error', server: `${SERVER} / ${DATABASE}`, message: err ? err.message : 'disconnected' }))
      .build();
  }

  private watch(c: DbConnection) {
    const touch = () => this.schedule();
    c.db.sim.onInsert(touch); c.db.sim.onUpdate(touch); c.db.sim.onDelete(touch);
    c.db.building.onInsert(touch); c.db.building.onUpdate(touch); c.db.building.onDelete(touch);
    c.db.person.onInsert(touch); c.db.person.onUpdate(touch); c.db.person.onDelete(touch);
    c.db.task.onInsert(touch); c.db.task.onUpdate(touch); c.db.task.onDelete(touch);
    c.db.fix.onInsert(touch); c.db.fix.onUpdate(touch); c.db.fix.onDelete(touch);
    c.db.eventLog.onInsert(touch); c.db.eventLog.onDelete(touch);
    c.db.result.onInsert(touch); c.db.result.onUpdate(touch); c.db.result.onDelete(touch);
    c.db.presence.onInsert(touch); c.db.presence.onUpdate(touch); c.db.presence.onDelete(touch);
    c.db.buildingProfile.onInsert(touch); c.db.buildingProfile.onUpdate(touch); c.db.buildingProfile.onDelete(touch);
    c.db.mitigation.onInsert(touch); c.db.mitigation.onUpdate(touch); c.db.mitigation.onDelete(touch);
    c.db.unit.onInsert(touch); c.db.unit.onUpdate(touch); c.db.unit.onDelete(touch);
    c.db.scenario.onInsert(touch); c.db.scenario.onUpdate(touch); c.db.scenario.onDelete(touch);
    c.db.fireCell.onInsert(touch);
    c.db.fireCell.onDelete(touch);
    c.db.fireCell.onUpdate((_ctx, oldRow, newRow) => {
      if (newRow.state === 2 && oldRow.state !== 2) this.burnedAt.set(newRow.id, c.db.sim.id.find(0)?.tick ?? 0);
      if (newRow.state !== 2) this.burnedAt.delete(newRow.id);
      this.schedule();
    });
  }

  private setConnection(connection: ConnectionState) {
    this.snapshot = { ...this.snapshot, connection };
    this.emit();
  }

  /** One rebuild per server transaction (row callbacks for a transaction arrive back to back). */
  private schedule() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => { this.pending = false; this.rebuild(); }, 0);
  }

  private rebuild() {
    const c = this.conn;
    if (!c) return;
    const s = c.db.sim.id.find(0);
    const sim: Sim = s ? { phase: s.phase as Phase, running: s.running, tick: s.tick, simMinutes: s.simMinutes, minutesPerTick: s.minutesPerTick, budgetLeft: s.budgetLeft, windDirDeg: s.windDirDeg, windMph: Math.round(s.windMph) } : EMPTY_SIM;

    const rawCells = [...c.db.fireCell.iter()].sort((a, b) => a.id - b.id);
    const cellById = new Map(rawCells.map((x) => [x.id, x]));
    const cells: FireCell[] = rawCells.map((x) => ({
      id: x.id, x: x.x, y: x.y, fuel: x.fuel, state: x.state,
      burnTicks: x.state === 2 ? COOL_FROM + Math.max(0, sim.tick - (this.burnedAt.get(x.id) ?? -1000)) : x.burnTicks,
    }));

    const buildings: Building[] = [...c.db.building.iter()].sort((a, b) => a.id - b.id).map((b) => {
      const key = `${b.x},${b.y},${b.w},${b.h}`;
      let fp = this.footprints.get(b.id);
      if (!fp || fp.key !== key) { fp = { key, ...footprint(b) }; this.footprints.set(b.id, fp); }
      let progress = 0;
      if (b.status === 'burning') for (const id of fp.inside) { const cell = cellById.get(id); if (cell && cell.state === 1) progress = Math.max(progress, cell.burnTicks / BUILDING_BURN_STEPS); }
      const damage = b.status === 'lost' ? 3 : b.status === 'burning' ? (progress >= 0.55 ? 2 : 1) : 0;
      const touched = b.status === 'burning' || b.status === 'lost' || fp.ring.some((id) => (cellById.get(id)?.state ?? 0) !== 0);
      return { ...b, kind: b.kind as BuildingKind, status: b.status as BuildingStatus, damage, burnProgress: b.status === 'lost' ? 1 : Math.min(1, progress), touched };
    });

    const tasks: Task[] = [...c.db.task.iter()].map((t) => ({
      id: Number(t.id), kind: 'help_person', buildingId: t.buildingId, personId: t.personId, priority: t.priority,
      claimedBy: t.claimedBy, done: t.done, createdTick: t.createdTick, auto: t.claimedBy.endsWith(AUTO_SUFFIX),
    }));
    const hasTask = new Set(tasks.map((t) => t.personId));
    const persons: Person[] = [...c.db.person.iter()].sort((a, b) => a.id - b.id).map((p) => ({
      ...p, status: p.status as PersonStatus,
      // the module records every reply (button replies too), so a task with no reply text means escalation
      escalated: hasTask.has(p.id) && p.replyText === '',
    }));

    const events: LogEvent[] = [...c.db.eventLog.iter()]
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, 40)
      .map((e) => ({ id: Number(e.id), tick: e.tick, text: e.text, ...classify(e.text) }));

    const fixes = [...c.db.fix.iter()].sort((a, b) => a.id - b.id);
    const approved: Record<number, string[]> = {};
    for (const f of fixes) if (f.approved) (approved[f.buildingId] ??= []).push(String(f.id));

    const w = c.db.result.scenario.find('with_lantern');
    const wo = c.db.result.scenario.find('without_lantern');
    const strip = (r: Rows.Result): ScenarioResult => ({ peopleSafe: r.peopleSafe, peopleTotal: r.peopleTotal, buildingsLost: r.buildingsLost, damageUsd: r.damageUsd, claims: r.claims });

    const profiles = new Map<number, BuildingProfile>();
    for (const r of c.db.buildingProfile.iter()) profiles.set(r.buildingId, { reachProbability: r.reachProbability, roof: r.roof, vents: r.vents, eaves: r.eaves, windows: r.windows, siding: r.siding, yearBuilt: r.yearBuilt, sources: r.sources });
    const checklists = new Map<number, Measure[]>();
    for (const r of [...c.db.mitigation.iter()].sort((a, b) => a.id - b.id)) {
      const list = checklists.get(r.buildingId) ?? [];
      list.push({ measure: r.measure, status: r.status as Measure['status'], fixId: r.fixId, note: r.note });
      checklists.set(r.buildingId, list);
    }
    const present = [...c.db.presence.iter()];
    const units: Unit[] = [...c.db.unit.iter()].sort((a, b) => a.id - b.id).map((u) => ({
      id: u.id, name: u.name, status: u.status as Unit['status'], targetId: u.targetId || null, ticksLeft: u.ticksLeft, travelTicks: u.travelTicks,
    }));

    const sc = c.db.scenario.id.find(0);
    // keep the same object while nothing changed, so the map does not re-render for it
    const prevSc = this.snapshot.scenario;
    const scenario: ScenarioInfo | undefined = !sc ? undefined
      : prevSc && prevSc.number === sc.number && prevSc.label === sc.label && prevSc.ignitionX === sc.ignitionX && prevSc.ignitionY === sc.ignitionY && prevSc.picked === sc.picked ? prevSc
        : { number: sc.number, label: sc.label, ignitionX: sc.ignitionX, ignitionY: sc.ignitionY, picked: sc.picked };

    this.snapshot = {
      sim, buildings, cells, persons, tasks, events, approved, fixes, results: w && wo ? { with: strip(w), without: strip(wo) } : undefined, connection: this.snapshot.connection,
      profiles, checklists, devices: present.length, workerOnline: present.some((x) => x.worker), units, scenario,
    };
    this.emit();
  }

  private emit() { for (const l of this.listeners) l(); }
  subscribe = (l: () => void) => { this.listeners.add(l); this.connect(); return () => this.listeners.delete(l); };
  getSnapshot = () => this.snapshot;

  /** Run a reducer once connected; resolve to the server's error message, or null on success. */
  async call(fn: (c: DbConnection) => Promise<void>): Promise<string | null> {
    const c = await this.ready;
    try {
      await fn(c);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[lantern]', msg);
      return msg;
    }
  }

  fixId(buildingId: number, key: string): number | undefined {
    if (/^\d+$/.test(key)) return Number(key);
    const name = FIX_NAMES[key];
    return this.snapshot.fixes.find((f) => f.buildingId === buildingId && f.name === name)?.id;
  }
}

const store = new LiveStore();

export function useLiveWorld(): WorldApi {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const actions = useMemo(() => ({
    setSpeed: (s: 1 | 2 | 4) => void store.call((c) => c.reducers.setSpeed({ minutesPerTick: 2 * s })),
    setPhase: (phase: Phase) => void store.call((c) => c.reducers.setPhase({ phase })),
    startEvacuation: (id: number) => void store.call((c) => c.reducers.startEvacuation({ buildingId: id })),
    approveFix: (id: number, key: string) => void store.ready.then(() => {
      const fixId = store.fixId(id, key);
      if (fixId !== undefined) void store.call((c) => c.reducers.approveFix({ fixId }));
    }),
    approveRecommended: () => void store.call((c) => c.reducers.approveRecommended({})),
    endAndCompare: () => void store.call((c) => c.reducers.endAndCompare({})),
    togglePause: () => void store.call((c) => c.reducers.setRunning({ running: !store.snapshot.sim.running })),
    reset: () => void store.call((c) => c.reducers.resetSim({})),
    advance: (n: number) => void store.call((c) => c.reducers.advanceTicks({ ticks: Math.min(500, Math.max(1, Math.round(n))) })),
    // Fire engines live in the module's unit table (auto-dispatch to burning buildings + Lantern's own calls).
    dispatchUnit: (buildingId: number) => store.call((c) => c.reducers.dispatchUnit({ buildingId })),
    releaseUnit: (unitId: number) => store.call((c) => c.reducers.releaseUnit({ unitId })),
    replyCheckin: (personId: number, choice: 'safe' | 'cant_move' | 'text', text = '') => store.call((c) => c.reducers.replyCheckin({ personId, choice, text })),
    claimTask: (taskId: number, staffName: string) => store.call((c) => c.reducers.claimTask({ taskId: BigInt(taskId), staffName })),
    completeTask: (taskId: number) => store.call((c) => c.reducers.completeTask({ taskId: BigInt(taskId) })),
    assignStaff: (taskId: number) => store.call((c) => c.reducers.assignStaff({ taskId: BigInt(taskId) })),
    newScenario: (number: number) => store.call((c) => c.reducers.newScenario({ number: Math.max(0, Math.round(number)) })),
    setIgnition: (cellX: number, cellY: number) => store.call((c) => c.reducers.setIgnition({ cellX: Math.max(0, Math.floor(cellX)), cellY: Math.max(0, Math.floor(cellY)) })),
  }), []);
  const fixesFor = useMemo(() => {
    const by = new Map<number, FixView[]>();
    for (const f of snap.fixes) {
      const list = by.get(f.buildingId) ?? [];
      list.push({ key: String(f.id), name: f.name, cost: f.costUsd, riskDrop: f.riskDrop, addVans: f.addVans, simulated: f.name.startsWith('Clear brush') });
      by.set(f.buildingId, list);
    }
    return (id: number) => by.get(id) ?? [];
  }, [snap.fixes]);
  const m = snap.sim.minutesPerTick;
  return {
    sim: snap.sim, buildings: snap.buildings, cells: snap.cells, persons: snap.persons, tasks: snap.tasks,
    events: snap.events, approved: snap.approved, results: snap.results, units: snap.units,
    speed: m >= 8 ? 4 : m >= 4 ? 2 : 1,
    fixesFor,
    // A building is prepared when its (rounded) risk is under 70 and evacuation beats the fire (spacetimedb/src/sim.ts).
    prepared: { riskMax: 70, referenceEta: (b: Building) => b.fireEtaMin },
    connection: snap.connection,
    profileFor: (id: number) => snap.profiles.get(id),
    checklistFor: (id: number) => snap.checklists.get(id) ?? [],
    live: { devices: snap.devices, workerOnline: snap.workerOnline },
    scenario: snap.scenario,
    ...actions,
  };
}
