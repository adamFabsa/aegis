import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SC from '../src/scenario';
import * as S from '../src/sim';
import { SEED } from '../src/seed_data';
import { parseSeed } from '../src/seed';

test('the module scores buildings exactly like the pipeline model', () => {
  // Building 12: wood roof, unenclosed eaves, coarse vents, wood siding, single pane, 1960-1989 → 78.7 (data/out/building_risk.json)
  assert.equal(SC.modelRisk({ roof: 'Wood/Combustible', eaves: 'Unenclosed', vents: 'Coarse mesh (>1/8in)', siding: 'Wood/Combustible', windows: 'Single Pane', yearBand: '1960-1989' }), 78.7);
  assert.equal(SC.modelRisk({ roof: 'Tile/Concrete', eaves: 'Unenclosed', vents: 'Coarse mesh (>1/8in)', siding: 'Wood/Combustible', windows: 'Single Pane', yearBand: '1960-1989' }), 50.4);
});

test('a scenario is a valid seed, deterministic, and different from the demo', () => {
  const t = Date.now();
  const a = SC.makeScenario(SEED, 48213);
  const ms = Date.now() - t;
  assert.ok(ms < 3000, `generation took ${ms} ms`);
  parseSeed(JSON.stringify(a)); // occupancy, footprints, params all valid
  assert.deepEqual(SC.makeScenario(SEED, 48213), a, 'same number → same world');
  const b = SC.makeScenario(SEED, 7);
  assert.notDeepEqual(b.params.ignition, a.params.ignition);
  assert.notDeepEqual(a.buildings.map((x) => x.baseRisk), SEED.buildings.map((x) => x.baseRisk));
  for (const x of a.buildings) {
    assert.ok(x.reachProbability! >= 0 && x.reachProbability! <= 1);
    if (x.kind !== 'shelter') assert.match(x.explanation!, /^Risk \d+ if an Eaton-like fire reaches it/);
    for (const f of x.fixes) assert.ok(f.addVans > 0 || f.riskDrop > 0.5, `${x.name} ${f.name}`);
  }
  // it plays: the world builds and the fire starts
  const w = S.buildWorldFromSeed(a);
  S.startFire(w, a.params, a.params.fireSeed);
  assert.ok(w.cells.some((c) => c.state === 1), 'fire is burning');
});

test('across scenarios the fire usually reaches town and risk varies', () => {
  let reached = 0;
  const risks = new Set<number>();
  for (let n = 1; n <= 12; n++) {
    const s = SC.makeScenario(SEED, n);
    if (s.buildings.some((b) => b.kind !== 'shelter' && (b.referenceFireEtaMin ?? -1) >= 0)) reached++;
    for (const b of s.buildings) risks.add(Math.round(b.baseRisk));
  }
  assert.ok(reached >= 9, `fire reached town in ${reached}/12 scenarios`);
  assert.ok(risks.size >= 20, `${risks.size} distinct risk values`);
});

test('a picked fire start must be burnable', () => {
  assert.throws(() => SC.withIgnition(SEED, 9999, 0), /nothing to burn/);
  const b12 = SEED.buildings.find((b) => b.id === 12)!;
  const cs = SEED.params.cellSize;
  assert.throws(() => SC.withIgnition(SEED, Math.floor((b12.x + b12.w / 2) / cs) - 1, Math.floor((b12.y + b12.h / 2) / cs) - 1), /nothing to burn/);
  const s = SC.withIgnition(SEED, 45, 2);
  assert.ok(s.params.ignition.length > 0);
});
