// Tests the preview's Controller (no DOM) against the engine:
//   node --experimental-strip-types --test preview/test_preview.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from './app.js';
import { buildWorldFromSeed, startFire, stepSimulation, computeResults, runBaseline, applyFix, startEvacuation, applyReply } from '../spacetimedb/src/sim.ts';
import { SEED } from '../spacetimedb/src/seed_data.ts';

const P = SEED.params;

function playDemo(ctl: Controller) {
  const d = ctl.demoActions();
  d.prep();
  ctl.startFire();
  let guard = 0;
  while (ctl.sim.phase === 'fire' && guard++ < 5000) {
    d.onTick(ctl.sim.tick);
    ctl.step();
  }
}

test('scripted demo in the preview == the same script on the bare engine', () => {
  const ctl = new Controller();
  playDemo(ctl);
  assert.equal(ctl.sim.phase, 'ended');
  assert.ok(ctl.results, 'results computed at the end');

  // Same script directly on the engine (what the Spacetime module does).
  const w = buildWorldFromSeed(SEED);
  for (const id of [121, 122, 91]) {
    const f = w.fixes.find((x) => x.id === id)!;
    applyFix(w.sim, w.buildings.find((b) => b.id === f.buildingId)!, f, w.people, P);
  }
  startFire(w, P, P.fireSeed);
  while (w.sim.phase === 'fire') {
    const tick = w.sim.tick;
    if (tick === 2) for (const id of [12, 9, 20, 7]) startEvacuation(w, id, P);
    if (tick === 4) applyReply(w, 1201, 'cant_move', P);
    const m = w.tasks.find((t) => t.personId === 1201);
    if (tick === 8 && m && m.claimedBy === '') {
      m.claimedBy = 'Alex';
      w.people.find((x) => x.id === 1201)!.status = 'claimed';
    }
    if (tick === 14 && m && m.claimedBy === 'Alex' && !m.done) {
      m.done = true;
      w.people.find((x) => x.id === 1201)!.status = 'out';
    }
    stepSimulation(w, P, P.fireSeed);
  }
  assert.deepEqual(ctl.results!.with, computeResults(w, P, 'with_lantern'));
  assert.deepEqual(ctl.results!.without, runBaseline(SEED, { fireSeed: P.fireSeed }));
  assert.ok(ctl.results!.with.peopleSafe > ctl.results!.without.peopleSafe, 'Lantern saves more people on the demo fire');
});

test('claims are exclusive and tasks get unique ids', () => {
  const ctl = new Controller();
  ctl.startFire();
  assert.equal(ctl.startEvacuation(12), null);
  assert.equal(ctl.startEvacuation(12), 'evacuation already started');
  assert.equal(ctl.reply(1201, 'cant_move'), null);
  for (let i = 0; i < 8; i++) ctl.step();
  const ids = ctl.world.tasks.map((t) => t.id);
  assert.ok(ids.every((id) => id > 0n), 'every task has an id');
  assert.equal(new Set(ids.map(String)).size, ids.length, 'ids are unique');
  const maria = ctl.world.tasks.find((t) => t.personId === 1201)!;
  assert.equal(ctl.complete(maria.id), 'claim it first');
  assert.equal(ctl.claim(maria.id, 'Alex'), null);
  assert.equal(ctl.claim(maria.id, 'Sam'), 'already claimed by Alex');
  assert.equal(ctl.complete(maria.id), null);
  assert.equal(ctl.complete(maria.id), 'task already done');
  assert.equal(ctl.world.people.find((x) => x.id === 1201)!.status, 'out');
  assert.equal(ctl.openTasks().some((t) => t.id === maria.id), false);
});

test('prep rules, budget and back-to-prep keeps approved fixes', () => {
  const ctl = new Controller();
  assert.equal(ctl.approveFix(121), null);
  assert.equal(ctl.approveFix(121), 'already approved');
  assert.equal(ctl.approveFix(424242), 'unknown fix');
  const ids = ctl.approveRecommended();
  assert.ok(ids.length > 0);
  assert.ok(ctl.sim.budgetLeft >= 0);
  const approved = ctl.fixes.filter((f) => f.approved).map((f) => f.id).sort();
  ctl.startFire();
  for (let i = 0; i < 5; i++) ctl.step();
  ctl.backToPrep();
  assert.equal(ctl.sim.phase, 'prep');
  assert.equal(ctl.sim.tick, 0);
  assert.deepEqual(ctl.fixes.filter((f) => f.approved).map((f) => f.id).sort(), approved);
  assert.equal(ctl.world.cells.filter((c) => c.state !== 0).length, 0, 'grid reset');
  assert.equal(ctl.startEvacuation(12), 'evacuations start during the fire phase');
});

test('end & compare, speed changes and the clock', () => {
  const ctl = new Controller({ fireSeed: 777 });
  ctl.startFire();
  ctl.setSpeed(10);
  for (let i = 0; i < 3; i++) ctl.step();
  assert.equal(ctl.sim.simMinutes, 30);
  assert.equal(ctl.clock().local, 'Tue 18:48');
  ctl.setSpeed(99);
  assert.equal(ctl.sim.minutesPerTick, 10);
  assert.equal(ctl.endAndCompare(), null);
  assert.equal(ctl.sim.phase, 'ended');
  assert.equal(ctl.results!.with.peopleTotal, 260);
  assert.equal(ctl.endAndCompare(), 'no fire running');
});
