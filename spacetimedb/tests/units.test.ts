import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as U from '../src/units';
import * as S from '../src/sim';
import { SEED } from '../src/seed_data';

const b = (id: number, status = 'ok', extra: Partial<{ residents: number; peopleOut: number; kind: string }> = {}) => ({
  id, name: `Building ${id}`, kind: extra.kind ?? 'apartments', x: 400 + id * 10, y: 200, w: 60, h: 40, status,
  residents: extra.residents ?? 20, peopleOut: extra.peopleOut ?? 0, risk: 50,
});

test('auto-dispatch answers burning buildings but keeps one engine in reserve', () => {
  const units = U.freshUnits();
  const r = U.stepUnits(units, [b(1, 'burning', { residents: 5 }), b(2, 'burning', { residents: 30 }), b(3, 'burning')]);
  assert.equal(units.filter((u) => u.status === 'enroute').length, 2, 'two engines respond');
  assert.equal(units.filter((u) => u.status === 'ready').length, U.RESERVE, 'one held back');
  assert.equal(units[0].targetId, 2, 'most people still inside first');
  assert.ok(r.events.every((e) => /responding to/.test(e)));
});

test('an engine drives for travelTicks, then stays on scene and protects the building', () => {
  const units = U.freshUnits();
  const target = b(4);
  const d = U.dispatch(units, target, true);
  assert.ok(d.unit && /ahead of the fire/.test(d.event!));
  const t = d.unit!.travelTicks;
  assert.ok(t >= 5 && t <= 10);
  for (let i = 0; i < t - 1; i++) U.stepUnits(units, [target]);
  assert.equal(d.unit!.status, 'enroute');
  U.stepUnits(units, [target]);
  assert.equal(d.unit!.status, 'onscene');
  assert.deepEqual(U.protectedIds(units), [4]);
  assert.match(U.dispatch(units, target, true).error!, /already assigned/);
});

test('engines return from lost buildings and after release, then are ready again', () => {
  const units = U.freshUnits();
  const target = b(5);
  U.dispatch(units, target, true);
  const u = units[0];
  U.stepUnits(units, [target]);
  U.release(u);
  assert.equal(u.status, 'returning');
  assert.equal(u.travelTicks, 1, 'turns around after one tick of driving');
  U.stepUnits(units, [target]);
  assert.equal(u.status, 'ready');
  assert.equal(u.targetId, 0);
  U.dispatch(units, target, true);
  U.stepUnits(units, [{ ...target, status: 'lost' }]);
  assert.equal(units[0].status, 'returning');
  assert.match(U.dispatch(units, { ...target, status: 'lost' }, true).error!, /already lost/);
  assert.match(U.dispatch(units, b(9, 'ok', { kind: 'shelter' }), true).error!, /shelter/);
});

test('protection lowers ignition without shifting the random streams', () => {
  const seed = S.buildWorldFromSeed(SEED);
  const p = SEED.params;
  const run = (protect: number[]) => {
    const w = S.buildWorldFromSeed(SEED);
    S.startFire(w, p, p.fireSeed);
    w.protectedBuildingIds = protect;
    for (let i = 0; i < 400 && w.sim.phase === 'fire'; i++) S.stepSimulation(w, p, p.fireSeed);
    return w;
  };
  const plain = run([]);
  const again = run([]);
  assert.deepEqual(plain.buildings.map((x) => x.status), again.buildings.map((x) => x.status), 'deterministic');
  // protecting every building can only keep buildings standing, never burn more
  const all = run(seed.buildings.map((x) => x.id));
  const lost = (w: S.World) => w.buildings.filter((x) => x.status === 'lost').length;
  assert.ok(lost(all) <= lost(plain), `protected ${lost(all)} vs plain ${lost(plain)}`);
});
