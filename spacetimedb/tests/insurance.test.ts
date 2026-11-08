// Insurer-ready mitigation checklist (California "Safer from Wildfires" measures) on the real seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEASURES, applyFixToChecklist, measureForFix, mitigationRows } from '../src/insurance.ts';
import type { SeedBuilding } from '../src/sim.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILDINGS: SeedBuilding[] = JSON.parse(readFileSync(resolve(ROOT, 'seed/buildings.json'), 'utf8')).buildings;
const byId = (id: number) => BUILDINGS.find((b) => b.id === id)!;
const status = (rows: ReturnType<typeof mitigationRows>, label: string) => rows.find((r) => r.measure === label)!;

test('Building 12 (wood roof, coarse vents, combustibles attached): missing measures point at the fixes', () => {
  const rows = mitigationRows(byId(12));
  assert.equal(rows.length, MEASURES.length);
  const roof = status(rows, 'Class A fire-rated roof');
  assert.equal(roof.status, 'missing');
  assert.equal(roof.fixId, byId(12).fixes.find((f) => f.name === 'Class A roof')!.id);
  assert.equal(status(rows, 'Ember- and flame-resistant vents').status, 'missing');
  assert.equal(status(rows, 'Enclosed eaves').status, 'missing');
  assert.equal(status(rows, 'Multi-pane windows').status, 'missing');
  assert.equal(status(rows, '6-inch non-combustible base of exterior walls').status, 'unverified');
  const zone0 = status(rows, '5-ft ember-resistant zone and defensible space');
  assert.equal(zone0.status, 'missing');
  assert.match(zone0.note, /fence/);
});

test('Building 3 (tile roof, fine mesh vents, built under the WUI code) already meets most measures', () => {
  const rows = mitigationRows(byId(3));
  assert.equal(status(rows, 'Class A fire-rated roof').status, 'met');
  assert.equal(status(rows, 'Ember- and flame-resistant vents').status, 'met');
  assert.equal(status(rows, 'Enclosed eaves').status, 'met');
  assert.equal(status(rows, 'Multi-pane windows').status, 'met');
  assert.ok(rows.every((r) => r.status !== 'met' || r.fixId === 0), 'met measures do not offer a fix');
});

test('approving a fix documents exactly its measure, once; the van documents nothing', () => {
  const rows = mitigationRows(byId(12));
  const vents = byId(12).fixes.find((f) => f.name === 'Ember-resistant vent screens')!;
  const changed = applyFixToChecklist(rows, { ...vents, buildingId: 12 });
  assert.ok(changed);
  assert.equal(changed.status, 'met');
  assert.match(changed.note, /approved/);
  assert.equal(applyFixToChecklist(rows, { ...vents, buildingId: 12 }), undefined);
  const van = byId(12).fixes.find((f) => f.name === 'Second evacuation van')!;
  assert.equal(applyFixToChecklist(rows, { ...van, buildingId: 12 }), undefined);
  assert.equal(measureForFix('Second evacuation van'), undefined);
});

test('the shelter has no checklist; every other building has all measures', () => {
  for (const b of BUILDINGS) assert.equal(mitigationRows(b).length, b.kind === 'shelter' ? 0 : MEASURES.length, b.name);
});
