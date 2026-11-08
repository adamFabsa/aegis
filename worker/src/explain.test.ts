/**
 * Building notes in random scenarios, without any AI call:   npm test
 * Facts come from the building_profile row, the module's template triggers a rewrite, and a note written for an old
 * scenario never lands on a new one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { buildFacts, describeFeature, ExplanationWriter, factsHash, isTemplate, type Facts } from './explain';
import type { Building, BuildingProfile, Fix } from './module_bindings/types';
import { WorkerState } from './state';

const dir = mkdtempSync(join(tmpdir(), 'lantern-worker-test-'));
const states: WorkerState[] = [];
after(() => {
  for (const s of states) s.flush(); // pending debounced saves, before the folder goes
  rmSync(dir, { recursive: true, force: true });
});
const freshState = () => {
  const s = new WorkerState(join(dir, `state-${states.length}.json`));
  states.push(s);
  return s;
};

const TEMPLATE_A =
  'Risk 64 if an Eaton-like fire reaches it — driven by roof: wood/combustible, vents: coarse mesh (>1/8in), year built: 1960-1989. Biggest single fix: Class A roof (−20).';
const TEMPLATE_B = 'Risk 22 if an Eaton-like fire reaches it — driven by eaves: unenclosed, windows: single pane.';

function building(over: Partial<Building> = {}): Building {
  return {
    id: 12, name: 'Sunrise Senior Living', kind: 'senior', x: 0, y: 0, w: 10, h: 10, residents: 40, needsHelp: 3, staff: 4, vans: 1,
    valueUsd: 12_000_000, risk: 64, baseRisk: 64, prepared: false, status: 'ok', fireEtaMin: 40, evacNeededMin: 55,
    evacStarted: false, peopleOut: 0, explanation: TEMPLATE_A, ...over,
  };
}
function profile(over: Partial<BuildingProfile> = {}): BuildingProfile {
  return {
    buildingId: 12, reachProbability: 0.8, roof: 'Wood/Combustible', vents: 'Coarse mesh (>1/8in)', eaves: 'Unenclosed',
    windows: 'Single Pane', siding: 'Stucco/Brick/Cement', yearBuilt: 1972, sources: '', ...over,
  };
}
const fix = (id: number, name: string, riskDrop: number, addVans = 0): Fix => ({ id, buildingId: 12, name, costUsd: 1000, riskDrop, addVans, approved: false });
const FIXES_A = [fix(124, 'Class A roof', 20.4), fix(123, 'Ember-resistant vent screens', 9.1), fix(121, 'Second evacuation van', 0, 1)];
const FIXES_B = [fix(122, 'Clear brush to 30 ft', 6.2)];

/** Facts minus the fix names (the only place digits may appear, e.g. "Clear brush to 30 ft"). */
const wordsOnly = (f: Facts) => JSON.stringify({ ...f, fixesRankedByModel: f.fixesRankedByModel.map((x) => ({ ...x, name: '' })) });

describe('buildFacts', () => {
  test('construction, age and drivers come from the building_profile row and the current template', () => {
    const f = buildFacts(building(), FIXES_A, profile());
    assert.deepEqual(f.construction, {
      roof: 'combustible wood roof',
      vents: 'coarse mesh vent screens that let embers through',
      eaves: 'open eaves that can trap embers',
      windows: 'single-pane windows that can break in the heat',
      siding: 'stucco, brick or cement siding', // the seed file says 'Wood' for building 12: the profile wins
    });
    assert.equal(f.age, 'older construction, built long before current wildfire building codes');
    assert.deepEqual(f.modelTopRiskDrivers, [
      'combustible wood roof',
      'coarse mesh vent screens that let embers through',
      'age: older construction, built long before current wildfire building codes',
    ]);
    assert.equal(f.riskLevel, 'high');
    assert.equal(f.buildingType, 'senior-living building');
    assert.equal(f.hasResidentsWhoNeedHelpMoving, true);
    assert.equal(f.evacuationSlowerThanFire, true);
    assert.deepEqual(f.fixesRankedByModel.map((x) => x.name), ['Class A roof', 'Ember-resistant vent screens', 'Second evacuation van']);
    assert.doesNotMatch(wordsOnly(f), /\d/);
  });

  test('a new scenario (new profile + template) gives new facts', () => {
    const p = profile({ roof: 'Tile/Concrete', vents: 'Fine mesh (<=1/8in)', eaves: 'Unenclosed', windows: 'Single Pane', siding: 'Ignition resistant', yearBuilt: 2015 });
    const f = buildFacts(building({ risk: 22, needsHelp: 0, fireEtaMin: -1, explanation: TEMPLATE_B }), FIXES_B, p);
    assert.equal(f.construction.roof, 'tile or concrete roof');
    assert.equal(f.construction.vents, 'fine ember-resistant mesh vent screens');
    assert.equal(f.construction.siding, 'ignition-resistant siding');
    assert.equal(f.age, 'built to current wildfire building codes');
    assert.deepEqual(f.modelTopRiskDrivers, ['open eaves that can trap embers', 'single-pane windows that can break in the heat']);
    assert.equal(f.riskLevel, 'low');
    assert.equal(f.evacuationSlowerThanFire, undefined); // fire not expected to reach it (−1)
    assert.notEqual(factsHash(f), factsHash(buildFacts(building(), FIXES_A, profile())));
    assert.doesNotMatch(wordsOnly(f), /\d/);
  });

  test('without a template (our note replaced it) the drivers are empty, not stale', () => {
    const f = buildFacts(building({ explanation: 'Approve the Class A roof first for this building.' }), FIXES_A, profile());
    assert.deepEqual(f.modelTopRiskDrivers, []);
    assert.equal(f.construction.roof, 'combustible wood roof');
  });

  test('falls back to the seed file only when the profile row is missing', () => {
    const f = buildFacts(building(), FIXES_A, undefined);
    assert.equal(f.construction.siding, 'combustible wood siding'); // seed/buildings.json: building 12 siding 'Wood'
    assert.equal(f.age, 'older construction, built long before current wildfire building codes'); // seed: 1968
    assert.doesNotMatch(wordsOnly(f), /\d/);
  });

  test('every model and seed value reads as plain words (no digits, units or symbols)', () => {
    const values: Record<string, string[]> = {
      roof: ['Asphalt', 'Tile/Concrete', 'Metal', 'Fire Resistant', 'Wood/Combustible', 'Wood', 'Tile'],
      eaves: ['Unenclosed', 'Enclosed', 'No Eaves'],
      vents: ['Coarse mesh (>1/8in)', 'Fine mesh (<=1/8in)', 'Screened (size unknown)', 'Unscreened', 'No vents', 'Mesh Screen > 1/8"', 'Mesh Screen <= 1/8"'],
      siding: ['Stucco/Brick/Cement', 'Metal', 'Ignition resistant', 'Wood/Combustible', 'Wood', 'Stucco Brick Cement'],
      windows: ['Single Pane', 'Multi Pane'],
      deckGrade: ['Masonry/Concrete', 'No Deck/Porch'],
    };
    const seen = new Set<string>();
    for (const [k, vs] of Object.entries(values))
      for (const v of vs) {
        const d = describeFeature(k, v);
        assert.ok(d, `${k}=${v}`);
        assert.doesNotMatch(d, /[\d"<>=+/()]/, `${k}=${v} → ${d}`);
        seen.add(`${k}:${d}`);
      }
    assert.equal(describeFeature('vents', 'Unscreened'), 'unscreened vents that let embers in');
    assert.equal(describeFeature('vents', 'Screened (size unknown)'), 'screened vents of unknown mesh size');
    assert.equal(describeFeature('vents', 'Mesh Screen <= 1/8"'), describeFeature('vents', 'Fine mesh (<=1/8in)'));
    assert.equal(describeFeature('eaves', 'Enclosed'), 'enclosed eaves');
    assert.equal(describeFeature('deckGrade', 'Masonry/Concrete'), 'masonry or concrete');
    assert.equal(describeFeature('yearBuilt', 1972), undefined);
    assert.equal(describeFeature('roof', ''), undefined);
  });
});

describe('needsNote', () => {
  const writer = (b: Building) =>
    new ExplanationWriter(freshState(), {
      building: () => b, fixes: () => FIXES_A, profile: () => profile(), setExplanation: async () => {}, onAuthFailure: () => {},
    });

  test('module templates match, worker notes do not', () => {
    for (const t of [
      TEMPLATE_A,
      TEMPLATE_B,
      'Risk 9 if an Eaton-like fire reaches it.',
      'Risk 41 if an Eaton-like fire reaches it — driven by siding: wood/combustible. Biggest single fix: Clear brush to 30 ft (−7).',
      'Risk 79 if an Eaton-like fire reaches it — driven by roof: wood/combustible, vents: coarse mesh (>1/8in), year built: 1960-1989. Biggest single fix: Class A roof (−28).',
      'Shelter A is the evacuation destination. Model risk 38.',
      ' Riverside Gym is the evacuation destination. Model risk 12.4. ',
    ])
      assert.equal(isTemplate(t), true, t);
    for (const t of [
      'Approve the Class A roof first for this building. Its wood roof and coarse vents let embers in, and the fix keeps residents safe and cuts the expected insurance claim.',
      'Risk is high here: approve Clear brush to 30 ft first.',
      '',
    ])
      assert.equal(isTemplate(t), false, t);
  });

  test('rewrites empty text and any scenario template (not just the seed file one); leaves notes and shelters alone', () => {
    const scenarioTemplate = 'Risk 37 if an Eaton-like fire reaches it — driven by windows: single pane. Biggest single fix: Ember-resistant vent screens (−6).';
    for (const explanation of ['', '  ', TEMPLATE_A, scenarioTemplate]) {
      const b = building({ explanation });
      assert.equal(writer(b).needsNote(b), true, JSON.stringify(explanation));
    }
    const note = building({ explanation: 'Approve the Class A roof first for this building. It keeps residents safe and cuts the claim.' });
    assert.equal(writer(note).needsNote(note), false);
    const shelter = building({ id: 99, kind: 'shelter', explanation: 'Shelter A is the evacuation destination. Model risk 38.' });
    assert.equal(writer(shelter).needsNote(shelter), false);
  });
});

// ───────────── writer against a fake database ─────────────

function fakeWorld() {
  const db = { building: building(), profile: profile() as BuildingProfile | undefined, fixes: FIXES_A };
  const written: string[] = [];
  const calls: Facts[] = [];
  let pending: Array<(note: string) => void> = [];
  const deps = {
    building: () => db.building,
    fixes: () => db.fixes,
    profile: () => db.profile,
    setExplanation: async (_id: number, text: string) => {
      written.push(text);
      db.building = { ...db.building, explanation: text };
    },
    onAuthFailure: () => {},
    writeNote: (_b: Building, facts: Facts) => {
      calls.push(facts);
      return new Promise<string>((r) => pending.push(r));
    },
  };
  /** Resolve the oldest in-flight note. */
  const answer = async (note: string) => {
    for (let i = 0; i < 100 && !pending.length; i++) await new Promise((r) => setTimeout(r, 5));
    const r = pending.shift();
    assert.ok(r, 'a note was requested');
    r(note);
    await new Promise((r) => setTimeout(r, 5));
  };
  const scenarioB = () => {
    db.building = building({ risk: 22, needsHelp: 0, explanation: TEMPLATE_B });
    db.profile = profile({ roof: 'Tile/Concrete', vents: 'Fine mesh (<=1/8in)', siding: 'Ignition resistant', yearBuilt: 2015 });
    db.fixes = FIXES_B;
  };
  const scenarioA = () => {
    db.building = building();
    db.profile = profile();
    db.fixes = FIXES_A;
  };
  return { db, deps, written, calls, answer, scenarioA, scenarioB };
}

const NOTE_A = 'Approve the Class A roof first for this building. Its combustible wood roof lets embers in, and the fix keeps residents safe and cuts the expected insurance claim.';
const NOTE_B = 'This building is in good shape, so just Clear brush to 30 ft as cheap upkeep. Its open eaves are the main weak spot, and clearing brush keeps residents safe and the claim low.';

describe('ExplanationWriter in scenarios', () => {
  test('writes a note for the template, then re-writes for a new scenario', async () => {
    const w = fakeWorld();
    const writer = new ExplanationWriter(freshState(), w.deps);
    writer.observe(w.db.building);
    await w.answer(NOTE_A);
    await writer.idle();
    assert.deepEqual(w.written, [NOTE_A]);
    assert.equal(writer.needsNote(w.db.building), false);

    w.scenarioB(); // new_scenario: building row reset to its template, profile and fixes rewritten
    writer.observe(w.db.building);
    await w.answer(NOTE_B);
    await writer.idle();
    assert.deepEqual(w.written, [NOTE_A, NOTE_B]);
    assert.equal(w.calls[1].construction.roof, 'tile or concrete roof');
  });

  test('a note still being written for the old scenario is not written over the new one', async () => {
    const w = fakeWorld();
    const writer = new ExplanationWriter(freshState(), w.deps);
    writer.observe(w.db.building); // scenario A: model starts writing
    for (let i = 0; i < 100 && !w.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    w.scenarioB(); // new scenario lands while the model is still writing A's note
    writer.observe(w.db.building);
    await w.answer(NOTE_A); // A's note arrives late → dropped
    await w.answer(NOTE_B);
    await writer.idle();
    assert.deepEqual(w.written, [NOTE_B]);
    assert.equal(w.db.building.explanation, NOTE_B);
  });

  test("a note that lands just after a new scenario is replaced (it describes the old world)", async () => {
    const w = fakeWorld();
    const writer = new ExplanationWriter(freshState(), w.deps);
    // set_explanation races new_scenario on the server: the module applies the scenario first, then our old note.
    w.deps.setExplanation = async (_id, text) => {
      w.written.push(text);
      if (text === NOTE_A) {
        w.scenarioB();
        writer.observe(w.db.building); // the scenario transaction
      }
      w.db.building = { ...w.db.building, explanation: text };
      writer.observe(w.db.building); // our set_explanation transaction
    };
    writer.observe(w.db.building);
    await w.answer(NOTE_A);
    await w.answer(NOTE_B);
    await writer.idle();
    assert.deepEqual(w.written, [NOTE_A, NOTE_B]);
    assert.equal(w.db.building.explanation, NOTE_B);
    // the rewrite still had the new scenario's drivers, though the template was gone from the row by then
    assert.deepEqual(w.calls[1].modelTopRiskDrivers, ['open eaves that can trap embers', 'single-pane windows that can break in the heat']);
  });

  test('cached notes: back to a scenario, or a restarted worker, asks the model nothing', async () => {
    const w = fakeWorld();
    const state = freshState();
    const writer = new ExplanationWriter(state, w.deps);
    writer.observe(w.db.building);
    await w.answer(NOTE_A);
    await writer.idle();
    w.scenarioB();
    writer.observe(w.db.building);
    await w.answer(NOTE_B);
    await writer.idle();

    w.scenarioA(); // back to the first scenario: template again, same facts
    writer.observe(w.db.building);
    await writer.idle();
    assert.equal(w.calls.length, 2);
    assert.deepEqual(w.written, [NOTE_A, NOTE_B, NOTE_A]);

    w.scenarioB(); // reset_sim / restart: a new writer on the same state
    const restarted = new ExplanationWriter(state, w.deps);
    restarted.observe(w.db.building);
    await restarted.idle();
    assert.equal(w.calls.length, 2);
    assert.equal(w.db.building.explanation, NOTE_B);
  });

  test('an approved fix or the fire moving does not trigger a rewrite of a written note', async () => {
    const w = fakeWorld();
    const writer = new ExplanationWriter(freshState(), w.deps);
    writer.observe(w.db.building);
    await w.answer(NOTE_A);
    await writer.idle();
    w.db.fixes = FIXES_A.map((f) => (f.id === 124 ? { ...f, approved: true } : f));
    w.db.building = { ...w.db.building, risk: 44, fireEtaMin: 12 };
    writer.observe(w.db.building);
    await writer.idle();
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.written, [NOTE_A]);
  });
});
