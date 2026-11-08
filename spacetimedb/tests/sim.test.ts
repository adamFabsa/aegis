// Plain-Node tests for the pure simulation engine (no SpacetimeDB needed):
//   node --experimental-strip-types --test spacetimedb/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mulberry32, tickStreams, fmtMin, makeEngine, fireSubstep, buildWorldFromSeed, startFire, stepSimulation,
  startEvacuation, applyReply, applyFix, computeResults, runBaseline, evacNeededMin, helpRatePerHour,
  igniteProb, recommendFixes, AUTO_SUFFIX,
} from '../src/sim.ts';
import type { FireParams, FireGrid, Seed, WindSample } from '../src/sim.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const J = (f: string) => JSON.parse(readFileSync(resolve(ROOT, 'seed', f), 'utf8'));
const SEED: Seed = { buildings: J('buildings.json').buildings, people: J('people.json').people, params: J('fire_params.json') };
const P = SEED.params;

/** Tiny open grid for physics tests. */
function grid(cols: number, rows: number, fuelAt: (x: number, y: number) => number, over: Partial<FireParams> = {}): FireParams {
  const fuel: number[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) fuel.push(fuelAt(x, y));
  return { ...P, cols, rows, fuel, ignition: [], wind: [], ...over };
}
function lit(p: FireParams, cells: number[], nb = 0): FireGrid {
  const n = p.cols * p.rows;
  const g: FireGrid = { state: new Uint8Array(n), burn: new Uint8Array(n), bstate: new Uint8Array(nb), burning: [] };
  for (const c of cells) {
    g.state[c] = 1;
    g.burning.push(c);
  }
  return g;
}
const calm: WindSample = { minute: 0, dirDeg: 90, mph: 0, gustMph: 0 };
const eastWind: WindSample = { minute: 0, dirDeg: 90, mph: 40, gustMph: 60 }; // blows toward +x

test('rng is deterministic and in [0,1)', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  const s1 = tickStreams(5, 3).fire();
  assert.equal(s1, tickStreams(5, 3).fire());
  assert.notEqual(s1, tickStreams(5, 4).fire());
  assert.notEqual(s1, tickStreams(6, 3).fire());
});

test('fmtMin', () => {
  assert.equal(fmtMin(110), '1h50m');
  assert.equal(fmtMin(45), '45m');
  assert.equal(fmtMin(180), '3h00m');
  assert.equal(fmtMin(-1), '—');
});

test('Building 12 evacuation: ~3h with one van, ~1h35m with two', () => {
  const w = buildWorldFromSeed(SEED);
  const b = w.buildings.find((x) => x.id === 12)!;
  const ppl = w.people.filter((x) => x.buildingId === 12);
  assert.equal(Math.round(evacNeededMin(b, ppl, P)), 180);
  assert.equal(Math.round(evacNeededMin({ ...b, vans: 2 }, ppl, P)), 95);
  assert.ok(helpRatePerHour({ staff: 0, vans: 0 }, P) > 0, 'staffless buildings still get outside help');
});

test('a road (fuel 0) stops direct spread; embers can jump it', () => {
  const road = (x: number) => (x === 10 || x === 11 ? 0 : 1);
  const noEmbers = grid(30, 9, road, { spotP: 0 });
  const e0 = makeEngine(noEmbers, noEmbers.fuel, []);
  const rng = mulberry32(1);
  for (let r = 0; r < 20; r++) {
    const g = lit(noEmbers, [4 * 30 + 2]);
    for (let s = 0; s < 80 && g.burning.length; s++) fireSubstep(e0, g, rng, eastWind);
    for (let y = 0; y < 9; y++) for (let x = 12; x < 30; x++) assert.equal(g.state[y * 30 + x], 0, 'fire crossed a road without embers');
  }
  const embers = grid(30, 9, road, { spotP: 0.2 });
  const e1 = makeEngine(embers, embers.fuel, []);
  let crossed = 0;
  for (let r = 0; r < 20; r++) {
    const g = lit(embers, [4 * 30 + 2]);
    for (let s = 0; s < 80 && g.burning.length; s++) fireSubstep(e1, g, rng, eastWind);
    let any = false;
    for (let y = 0; y < 9; y++) for (let x = 12; x < 30; x++) if (g.state[y * 30 + x] !== 0) any = true;
    if (any) crossed++;
  }
  assert.ok(crossed > 10, `embers crossed in only ${crossed}/20 fires`);
});

test('fire runs downwind', () => {
  const p = grid(41, 21, () => 1, { spotP: 0, baseSpread: 0.25 });
  const eng = makeEngine(p, p.fuel, []);
  const rng = mulberry32(3);
  let down = 0;
  let up = 0;
  for (let r = 0; r < 20; r++) {
    const g = lit(p, [10 * 41 + 20]);
    for (let s = 0; s < 12; s++) fireSubstep(eng, g, rng, eastWind);
    for (let i = 0; i < p.cols * p.rows; i++) {
      if (g.state[i] === 0) continue;
      const x = i % 41;
      if (x > 20) down++;
      if (x < 20) up++;
    }
  }
  assert.ok(down > 3 * up, `downwind ${down} vs upwind ${up}`);
});

test('buildings are firebreaks until they ignite; low risk survives more often', () => {
  const p = grid(21, 11, () => 0.6, { spotP: 0, baseSpread: 0.6 });
  const lost = (risk: number) => {
    let n = 0;
    const rng = mulberry32(11);
    for (let r = 0; r < 200; r++) {
      const eng = makeEngine(p, p.fuel, [{ id: 1, x: 200, y: 80, w: 40, h: 40, risk }]);
      const g = lit(p, [5 * 21 + 1], 1);
      for (let s = 0; s < 120 && g.burning.length; s++) {
        fireSubstep(eng, g, rng, calm);
        if (g.bstate[0] === 0) for (const c of eng.foot[0]) assert.equal(g.state[c], 0, 'footprint burned without the building igniting');
      }
      if (g.bstate[0] === 2) n++;
    }
    return n;
  };
  const hi = lost(90);
  const lo = lost(10);
  assert.ok(hi > lo + 40, `risk 90 lost ${hi}/200 vs risk 10 lost ${lo}/200`);
  assert.ok(igniteProb(90, P) > igniteProb(10, P));
});

test('prep: fixes cost budget, lower risk, and Building 12 becomes Prepared with van + brush', () => {
  const w = buildWorldFromSeed(SEED);
  const b = w.buildings.find((x) => x.id === 12)!;
  assert.equal(b.prepared, false);
  const van = w.fixes.find((f) => f.buildingId === 12 && f.addVans > 0)!;
  const brush = w.fixes.find((f) => f.buildingId === 12 && f.name.startsWith('Clear brush'))!;
  const budget = w.sim.budgetLeft;
  assert.equal(applyFix(w.sim, b, van, w.people, P).error, undefined);
  assert.equal(b.vans, 2);
  assert.equal(b.evacNeededMin, 95);
  assert.equal(applyFix(w.sim, b, van, w.people, P).error, 'already approved');
  assert.equal(applyFix(w.sim, b, brush, w.people, P).error, undefined);
  assert.ok(b.risk < b.baseRisk);
  assert.equal(b.prepared, true);
  assert.equal(w.sim.budgetLeft, budget - van.costUsd - brush.costUsd);
  w.sim.budgetLeft = 1;
  const roof = w.fixes.find((f) => f.buildingId === 12 && f.name === 'Class A roof')!;
  assert.equal(applyFix(w.sim, b, roof, w.people, P).error, 'not enough budget left');
  w.sim.phase = 'fire';
  assert.match(applyFix(w.sim, b, roof, w.people, P).error ?? '', /prep/);
});

test('recommendFixes stays within budget', () => {
  const w = buildWorldFromSeed(SEED);
  const ids = recommendFixes(w, w.fixes, P);
  const cost = ids.reduce((t, id) => t + w.fixes.find((f) => f.id === id)!.costUsd, 0);
  assert.ok(ids.length > 0);
  assert.ok(cost <= w.sim.budgetLeft);
});

test('check-ins: "can\'t get out" → urgent task; silent → escalated once after escalateMin', () => {
  const w = buildWorldFromSeed(SEED);
  startFire(w, P, 1);
  startEvacuation(w, 12, P);
  const r = applyReply(w, 1201, 'cant_move', P);
  assert.ok(r.task && r.task.priority === 3 && r.task.id === 0n);
  assert.equal(w.people.find((x) => x.id === 1201)!.status, 'cant_move');
  assert.equal(applyReply(w, 1203, 'safe', P).person!.status, 'safe');
  const ticksToEscalate = Math.ceil(P.escalateMin / w.sim.minutesPerTick);
  let newTasks = 0;
  for (let i = 0; i < ticksToEscalate + 3; i++) {
    const res = stepSimulation(w, P, 1);
    newTasks += res.tasksNew.filter((t) => t.personId === 1202).length;
    assert.ok(res.tasksUpdated.every((t) => t.id !== 0n));
  }
  assert.equal(newTasks, 1, 'Robert K. escalated exactly once');
  const robertTask = w.tasks.find((t) => t.personId === 1202)!;
  assert.equal(robertTask.claimedBy, '', 'left open for humans during the claim window');
});

test('on-site staff take open tasks only after the human claim window', () => {
  const w = buildWorldFromSeed(SEED);
  startFire(w, P, 2);
  startEvacuation(w, 12, P);
  applyReply(w, 1201, 'cant_move', P);
  const created = w.sim.tick;
  for (let i = 0; i < P.autoClaimDelayTicks - 1; i++) stepSimulation(w, P, 2);
  assert.equal(w.tasks.find((t) => t.personId === 1201)!.claimedBy, '');
  for (let i = 0; i < 40 && w.sim.phase === 'fire'; i++) stepSimulation(w, P, 2);
  const maria = w.tasks.find((t) => t.personId === 1201)!;
  assert.ok(maria.claimedBy.endsWith(AUTO_SUFFIX), `claimed by "${maria.claimedBy}" after tick ${created}`);
});

test('a full live run ends, is deterministic per seed, and results add up', () => {
  const play = () => {
    const w = buildWorldFromSeed(SEED);
    startFire(w, P, P.fireSeed);
    let ticks = 0;
    while (w.sim.phase === 'fire' && ticks < 2000) {
      if (w.sim.tick === 2) startEvacuation(w, 12, P);
      stepSimulation(w, P, P.fireSeed);
      ticks++;
    }
    return { w, res: computeResults(w, P, 'with_lantern') };
  };
  const a = play();
  const b = play();
  assert.equal(a.w.sim.phase, 'ended');
  assert.deepEqual(a.res, b.res);
  assert.equal(a.res.peopleTotal, SEED.people.length);
  assert.ok(a.res.peopleSafe <= a.res.peopleTotal);
  const lost = a.w.buildings.filter((x) => x.status === 'lost').length;
  assert.equal(a.res.buildingsLost, lost);
  for (const x of a.w.people) if (a.w.buildings.find((q) => q.id === x.buildingId)!.status === 'lost') assert.ok(x.status === 'out' || x.status === 'left_behind');
});

test('same seed = same fire at any speed (so the baseline really is the same fire)', () => {
  const burnAt = (mpt: number) => {
    const w = buildWorldFromSeed(SEED);
    w.sim.minutesPerTick = mpt;
    startFire(w, P, P.fireSeed);
    let guard = 0;
    while (w.sim.phase === 'fire' && guard++ < 5000) {
      if (w.sim.tick === 3 && mpt === 2) w.sim.minutesPerTick = 7; // change speed mid-fire too
      stepSimulation(w, P, P.fireSeed);
    }
    return {
      cells: w.cells.map((c) => c.state).join(''),
      lost: w.buildings.filter((b) => b.status === 'lost').map((b) => b.id).join(','),
    };
  };
  const ref = burnAt(1);
  for (const mpt of [2, 5, 10]) assert.deepEqual(burnAt(mpt), ref, `fire differs at ${mpt} min/tick`);
});

test('an urgent task stays urgent after someone claims it', () => {
  const w = buildWorldFromSeed(SEED);
  startFire(w, P, 4);
  startEvacuation(w, 12, P);
  applyReply(w, 1201, 'cant_move', P);
  const t = w.tasks.find((x) => x.personId === 1201)!;
  t.claimedBy = 'Alex';
  w.people.find((x) => x.id === 1201)!.status = 'claimed';
  for (let i = 0; i < 8; i++) stepSimulation(w, P, 4);
  assert.equal(t.priority, 3);
  assert.equal(t.claimedBy, 'Alex', 'on-site staff never take over a human claim');
});

test('baseline is the same fire, deterministic, and never better on people than an early evacuation', () => {
  const b1 = runBaseline(SEED);
  const b2 = runBaseline(SEED);
  assert.deepEqual(b1, b2);
  assert.equal(b1.scenario, 'without_lantern');
  const w = buildWorldFromSeed(SEED);
  startFire(w, P, P.fireSeed);
  while (w.sim.phase === 'fire') {
    if (w.sim.tick === 1) for (const b of w.buildings) if (b.residents > 0) startEvacuation(w, b.id, P);
    stepSimulation(w, P, P.fireSeed);
  }
  const lantern = computeResults(w, P, 'with_lantern');
  assert.ok(lantern.peopleSafe >= b1.peopleSafe, `lantern ${lantern.peopleSafe} vs baseline ${b1.peopleSafe}`);
});
