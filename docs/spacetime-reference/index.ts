// REFERENCE (tested) SpacetimeDB 2.14 module: the spec's schema (LANTERN_SPEC §4) wired to sim.ts as SIM.md
// describes. Verified on a local 2.14.1 server: builds, seeds on init, 1 s scheduled tick (~0.9 ms per tick),
// atomic claims under a 10-way race, two live clients in sync, same results as the Node engine.
// To use: copy to spacetimedb/src/index.ts next to sim.ts + seed_data.ts (or crib the parts you need).
// Not wired in yet: worker-only auth for set_reply_class / set_explanation (check ctx.sender), set_explanation.
// bench_ticks is test-only — drop it before the demo.
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import * as S from './sim';
import { SEED } from './seed_data';

const P = SEED.params;

const sim = table({ name: 'sim', public: true }, {
  id: t.u32().primaryKey(),
  phase: t.string(),
  running: t.bool(),
  tick: t.u32(),
  simMinutes: t.u32(),
  minutesPerTick: t.u32(),
  budgetLeft: t.f64(),
  windDirDeg: t.f64(),
  windMph: t.f64(),
});

const building = table({ name: 'building', public: true }, {
  id: t.u32().primaryKey(),
  name: t.string(),
  kind: t.string(),
  x: t.f64(), y: t.f64(), w: t.f64(), h: t.f64(),
  residents: t.u32(),
  needsHelp: t.u32(),
  staff: t.u32(),
  vans: t.u32(),
  valueUsd: t.f64(),
  risk: t.f64(),
  baseRisk: t.f64(),
  prepared: t.bool(),
  status: t.string(),
  fireEtaMin: t.f64(),
  evacNeededMin: t.f64(),
  evacStarted: t.bool(),
  peopleOut: t.u32(),
  explanation: t.string(),
});

const person = table({ name: 'person', public: true }, {
  id: t.u32().primaryKey(),
  name: t.string(),
  buildingId: t.u32(),
  floor: t.u8(),
  needsHelp: t.bool(),
  note: t.string(),
  status: t.string(),
  pingedAtTick: t.u32(),
  replyText: t.string(),
});

const task = table({ name: 'task', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  kind: t.string(),
  buildingId: t.u32(),
  personId: t.u32(),
  priority: t.u8(),
  claimedBy: t.string(),
  done: t.bool(),
  createdTick: t.u32(),
});

const fix = table({ name: 'fix', public: true }, {
  id: t.u32().primaryKey(),
  buildingId: t.u32(),
  name: t.string(),
  costUsd: t.f64(),
  riskDrop: t.f64(),
  addVans: t.u32(),
  approved: t.bool(),
});

const fireCell = table({ name: 'fire_cell', public: true }, {
  id: t.u32().primaryKey(),
  x: t.u16(), y: t.u16(),
  fuel: t.f64(),
  state: t.u8(),
  burnTicks: t.u8(),
});

const eventLog = table({ name: 'event_log', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  tick: t.u32(),
  text: t.string(),
});

const result = table({ name: 'result', public: true }, {
  scenario: t.string().primaryKey(),
  peopleSafe: t.u32(),
  peopleTotal: t.u32(),
  buildingsLost: t.u32(),
  damageUsd: t.f64(),
  claims: t.u32(),
});

const simTick = table({ name: 'sim_tick' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

const spacetimedb = schema({ sim, building, person, task, fix, fireCell, eventLog, result, simTick });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ───────────── helpers (not exported) ─────────────

function loadWorld(ctx: Ctx): S.World {
  const s = ctx.db.sim.id.find(0);
  if (!s) throw new SenderError('not seeded');
  return {
    sim: { ...s },
    buildings: [...ctx.db.building.iter()].map((r) => ({ ...r })),
    people: [...ctx.db.person.iter()].map((r) => ({ ...r })),
    tasks: [...ctx.db.task.iter()].map((r) => ({ ...r })),
    cells: [...ctx.db.fireCell.iter()].map((r) => ({ ...r })),
  };
}

function log(ctx: Ctx, tick: number, lines: string[]) {
  for (const text of lines) ctx.db.eventLog.insert({ id: 0n, tick, text });
}

function save(ctx: Ctx, r: S.StepResult) {
  ctx.db.sim.id.update(r.sim);
  for (const c of r.cells) ctx.db.fireCell.id.update(c);
  for (const b of r.buildings) ctx.db.building.id.update(b);
  for (const p of r.people) ctx.db.person.id.update(p);
  for (const tk of r.tasksUpdated) ctx.db.task.id.update(tk);
  for (const tk of r.tasksNew) ctx.db.task.insert({ ...tk, id: 0n });
  log(ctx, r.sim.tick, r.events);
}

function upsertResult(ctx: Ctx, row: S.ResultRow) {
  if (ctx.db.result.scenario.find(row.scenario)) ctx.db.result.scenario.update(row);
  else ctx.db.result.insert(row);
}

function writeResults(ctx: Ctx, w: S.World) {
  upsertResult(ctx, S.computeResults(w, P, 'with_lantern'));
  upsertResult(ctx, S.runBaseline(SEED));
}

function clearAll(ctx: Ctx) {
  for (const r of [...ctx.db.building.iter()]) ctx.db.building.id.delete(r.id);
  for (const r of [...ctx.db.person.iter()]) ctx.db.person.id.delete(r.id);
  for (const r of [...ctx.db.task.iter()]) ctx.db.task.id.delete(r.id);
  for (const r of [...ctx.db.fix.iter()]) ctx.db.fix.id.delete(r.id);
  for (const r of [...ctx.db.fireCell.iter()]) ctx.db.fireCell.id.delete(r.id);
  for (const r of [...ctx.db.eventLog.iter()]) ctx.db.eventLog.id.delete(r.id);
  for (const r of [...ctx.db.result.iter()]) ctx.db.result.scenario.delete(r.scenario);
  for (const r of [...ctx.db.sim.iter()]) ctx.db.sim.id.delete(r.id);
}

function seed(ctx: Ctx, approvedFixIds: number[] = []) {
  clearAll(ctx);
  const w = S.buildWorldFromSeed(SEED);
  for (const id of approvedFixIds) {
    const f = w.fixes.find((x) => x.id === id);
    const b = f && w.buildings.find((x) => x.id === f.buildingId);
    if (f && b) S.applyFix(w.sim, b, f, w.people, P);
  }
  ctx.db.sim.insert(w.sim);
  for (const r of w.buildings) ctx.db.building.insert(r);
  for (const r of w.people) ctx.db.person.insert(r);
  for (const r of w.cells) ctx.db.fireCell.insert(r);
  for (const r of w.fixes) ctx.db.fix.insert(r);
  log(ctx, 0, ['World seeded — prep phase (SIMULATED neighbourhood, Eaton-calibrated fire)']);
}

// ───────────── lifecycle ─────────────

export const init = spacetimedb.init((ctx) => {
  seed(ctx);
  ctx.db.simTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
});

// ───────────── reducers ─────────────

export const tick = spacetimedb.reducer({ onSchedule: simTick }, { timer: simTick.rowType }, (ctx, { timer: _timer }) => {
  const s = ctx.db.sim.id.find(0);
  if (!s || s.phase !== 'fire' || !s.running) return;
  const w = loadWorld(ctx);
  const r = S.stepSimulation(w, P, P.fireSeed);
  save(ctx, r);
  if (r.ended) writeResults(ctx, w);
});

export const seedWorld = spacetimedb.reducer((ctx) => seed(ctx));
export const resetSim = spacetimedb.reducer((ctx) => seed(ctx));

export const setPhase = spacetimedb.reducer({ phase: t.string() }, (ctx, { phase }) => {
  if (phase === 'fire') {
    const w = loadWorld(ctx);
    if (w.sim.phase !== 'prep') throw new SenderError('reset to prep first');
    save(ctx, S.startFire(w, P, P.fireSeed));
  } else if (phase === 'prep') {
    seed(ctx, [...ctx.db.fix.iter()].filter((f) => f.approved).map((f) => f.id));
  } else throw new SenderError(`unknown phase '${phase}'`);
});

export const setSpeed = spacetimedb.reducer({ minutesPerTick: t.u32() }, (ctx, { minutesPerTick }) => {
  const s = ctx.db.sim.id.find(0);
  if (!s) throw new SenderError('not seeded');
  if (minutesPerTick < 1 || minutesPerTick > 10) throw new SenderError('speed must be 1–10 sim-minutes per tick');
  ctx.db.sim.id.update({ ...s, minutesPerTick });
});

export const setRunning = spacetimedb.reducer({ running: t.bool() }, (ctx, { running }) => {
  const s = ctx.db.sim.id.find(0);
  if (!s) throw new SenderError('not seeded');
  ctx.db.sim.id.update({ ...s, running });
});

export const approveFix = spacetimedb.reducer({ fixId: t.u32() }, (ctx, { fixId }) => {
  const s = ctx.db.sim.id.find(0);
  const f = ctx.db.fix.id.find(fixId);
  if (!s || !f) throw new SenderError('unknown fix');
  const b = ctx.db.building.id.find(f.buildingId);
  if (!b) throw new SenderError('unknown building');
  const simRow = { ...s };
  const bRow = { ...b };
  const fRow = { ...f };
  const people = [...ctx.db.person.iter()].filter((x) => x.buildingId === b.id);
  const r = S.applyFix(simRow, bRow, fRow, people, P);
  if (r.error) throw new SenderError(r.error);
  ctx.db.sim.id.update(simRow);
  ctx.db.building.id.update(bRow);
  ctx.db.fix.id.update(fRow);
  log(ctx, simRow.tick, [r.event ?? '']);
});

export const approveRecommended = spacetimedb.reducer((ctx) => {
  const w = loadWorld(ctx);
  const fixes = [...ctx.db.fix.iter()].map((f) => ({ ...f }));
  const ids = S.recommendFixes(w, fixes, P);
  const lines: string[] = [];
  for (const id of ids) {
    const f = fixes.find((x) => x.id === id);
    const b = f && w.buildings.find((x) => x.id === f.buildingId);
    if (!f || !b) continue;
    const r = S.applyFix(w.sim, b, f, w.people, P);
    if (r.error) continue;
    ctx.db.fix.id.update(f);
    ctx.db.building.id.update(b);
    lines.push(r.event ?? '');
  }
  ctx.db.sim.id.update(w.sim);
  log(ctx, w.sim.tick, lines);
});

export const startEvacuation = spacetimedb.reducer({ buildingId: t.u32() }, (ctx, { buildingId }) => {
  const w = loadWorld(ctx);
  const r = S.startEvacuation(w, buildingId, P);
  if (r.error) throw new SenderError(r.error);
  if (r.building) ctx.db.building.id.update(r.building);
  for (const p of r.people) ctx.db.person.id.update(p);
  log(ctx, w.sim.tick, r.events);
});

function reply(ctx: Ctx, personId: number, choice: string) {
  const w = loadWorld(ctx);
  const r = S.applyReply(w, personId, choice);
  if (r.error) throw new SenderError(r.error);
  if (r.person) ctx.db.person.id.update(r.person);
  for (const tk of r.tasksUpdated) ctx.db.task.id.update(tk);
  if (r.task) ctx.db.task.insert({ ...r.task, id: 0n });
  log(ctx, w.sim.tick, r.events);
}

export const replyCheckin = spacetimedb.reducer({ personId: t.u32(), choice: t.string(), text: t.string() }, (ctx, { personId, choice, text }) => {
  if (choice === 'text') {
    const p = ctx.db.person.id.find(personId);
    if (!p) throw new SenderError('unknown person');
    ctx.db.person.id.update({ ...p, replyText: text });
    return;
  }
  reply(ctx, personId, choice);
});

export const setReplyClass = spacetimedb.reducer({ personId: t.u32(), choice: t.string() }, (ctx, { personId, choice }) => {
  reply(ctx, personId, choice);
});

export const claimTask = spacetimedb.reducer({ taskId: t.u64(), staffName: t.string() }, (ctx, { taskId, staffName }) => {
  const tk = ctx.db.task.id.find(taskId);
  if (!tk) throw new SenderError('unknown task');
  if (tk.done) throw new SenderError('task already done');
  if (tk.claimedBy !== '') throw new SenderError(`already claimed by ${tk.claimedBy}`);
  ctx.db.task.id.update({ ...tk, claimedBy: staffName });
  const p = ctx.db.person.id.find(tk.personId);
  if (p && p.status !== 'out' && p.status !== 'left_behind') ctx.db.person.id.update({ ...p, status: 'claimed' });
  const s = ctx.db.sim.id.find(0);
  log(ctx, s ? s.tick : 0, [`${staffName} claimed ${p ? p.name : 'a task'}`]);
});

export const completeTask = spacetimedb.reducer({ taskId: t.u64() }, (ctx, { taskId }) => {
  const tk = ctx.db.task.id.find(taskId);
  if (!tk) throw new SenderError('unknown task');
  if (tk.done) throw new SenderError('task already done');
  if (tk.claimedBy === '') throw new SenderError('claim it first');
  ctx.db.task.id.update({ ...tk, done: true });
  const p = ctx.db.person.id.find(tk.personId);
  if (p && p.status !== 'left_behind') ctx.db.person.id.update({ ...p, status: 'out' });
  const s = ctx.db.sim.id.find(0);
  log(ctx, s ? s.tick : 0, [`${p ? p.name : 'Someone'} reached safety with ${tk.claimedBy}`]);
});

export const runBaseline = spacetimedb.reducer((ctx) => {
  upsertResult(ctx, S.runBaseline(SEED));
});

export const endAndCompare = spacetimedb.reducer((ctx) => {
  const w = loadWorld(ctx);
  if (w.sim.phase !== 'fire') throw new SenderError('no fire running');
  const before = new Set(w.tasks);
  S.fastForward(w, P, P.fireSeed);
  ctx.db.sim.id.update(w.sim);
  for (const c of w.cells) ctx.db.fireCell.id.update(c);
  for (const b of w.buildings) ctx.db.building.id.update(b);
  for (const p of w.people) ctx.db.person.id.update(p);
  for (const tk of w.tasks) {
    if (before.has(tk) && tk.id !== 0n) ctx.db.task.id.update(tk);
    else ctx.db.task.insert({ ...tk, id: 0n });
  }
  writeResults(ctx, w);
  log(ctx, w.sim.tick, ['Fast-forwarded to the end of the fire']);
});

// Test-only: run n ticks inside one reducer call so the cost per tick can be timed from outside.
export const benchTicks = spacetimedb.reducer({ n: t.u32() }, (ctx, { n }) => {
  for (let i = 0; i < n; i++) {
    const s = ctx.db.sim.id.find(0);
    if (!s || s.phase !== 'fire') break;
    const w = loadWorld(ctx);
    w.sim.running = true;
    const r = S.stepSimulation(w, P, P.fireSeed);
    r.sim.running = s.running;
    save(ctx, r);
    if (r.ended) writeResults(ctx, w);
  }
});
