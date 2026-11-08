/** Integration test against a disposable database. Replaces its seed and restores the default at the end. */
import assert from 'node:assert/strict';
import { adminToken, connect, subscribe } from './connect';
import { readSeed } from './seed';
import type { DbConnection } from '../web/src/module_bindings';

const MARIA = 1201; // wheelchair, Building 12
const ROBERT = 1202; // oxygen, never answers on his own
const MOBILE = 1210; // a Building 12 resident who can walk out
const clients: DbConnection[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test: () => boolean, label: string, timeout = 25000) {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await sleep(50);
  }
}
async function client(token?: string) {
  const c = await connect(token);
  clients.push(c);
  await subscribe(c);
  return c;
}
try {
  const admin = await client(adminToken()), a = await client(), b = await client(), worker = await client();
  // A slow, short fire so the scripted checks below run in a quiet world.
  const seed = readSeed();
  seed.params.maxSimMinutes = 30;
  seed.params.burnSteps = 200;
  seed.params.buildingBurnSteps = 250;
  seed.params.baseSpread = 0.001;
  seed.params.spotP = 0;
  await admin.reducers.seedWorld({ json: JSON.stringify(seed) });
  await waitFor(() => admin.db.person.count() === 260n, 'seed subscription');
  assert.equal(admin.db.fireCell.count(), 1550n);
  assert.equal(admin.db.sim.id.find(0)!.phase, 'prep');
  await assert.rejects(a.reducers.seedWorld({ json: JSON.stringify(seed) }), /administrator only/);
  await assert.rejects(a.reducers.registerWorker({ identity: a.identity! }), /administrator only/);
  await assert.rejects(a.reducers.setExplanation({ buildingId: 12, text: 'bad' }), /worker only/);
  // Presence: every connected client is a row (the dashboard's "N devices" chip).
  await waitFor(() => admin.db.presence.count() >= 4n, 'presence rows for the four clients');
  await admin.reducers.registerWorker({ identity: worker.identity! });
  await waitFor(() => [...admin.db.presence.iter()].some((p) => p.worker && p.identity.isEqual(worker.identity!)), 'worker flagged in presence');
  assert.equal(admin.db.buildingProfile.count(), 8n, 'a profile row per building');
  assert.equal([...admin.db.mitigation.iter()].filter((m) => m.buildingId === 12).length, 6, 'Building 12 has the six insurer measures');
  await worker.reducers.setExplanation({ buildingId: 12, text: 'Smoke-test explanation.' });
  const initialBudget = admin.db.sim.id.find(0)!.budgetLeft;
  await admin.reducers.approveFix({ fixId: 121 });
  await waitFor(() => admin.db.fix.id.find(121)!.approved, 'fix subscription');
  assert.equal(admin.db.building.id.find(12)!.vans, 2);
  assert.equal(admin.db.sim.id.find(0)!.budgetLeft, initialBudget - 48000);
  await assert.rejects(admin.reducers.approveFix({ fixId: 121 }), /already approved/);
  // Approving the vent screens documents the "ember-resistant vents" insurer measure.
  const ventsFix = [...admin.db.fix.iter()].find((f) => f.buildingId === 12 && f.name === 'Ember-resistant vent screens')!;
  await admin.reducers.approveFix({ fixId: ventsFix.id });
  await waitFor(() => [...admin.db.mitigation.iter()].some((m) => m.buildingId === 12 && m.measure === 'Ember- and flame-resistant vents' && m.status === 'met'), 'vents measure documented');
  const invalidSeed = { ...seed, people: [] };
  await assert.rejects(admin.reducers.seedWorld({ json: JSON.stringify(invalidSeed) }), /Occupancy mismatch/);
  assert.equal(admin.db.fix.id.find(121)!.approved, true);
  await admin.reducers.setPhase({ phase: 'fire' });
  await assert.rejects(admin.reducers.approveFix({ fixId: 122 }), /prep/);
  await assert.rejects(admin.reducers.setSpeed({ minutesPerTick: 0 }), /1–60/);
  await admin.reducers.startEvacuation({ buildingId: 12 });
  await waitFor(() => a.db.person.id.find(MARIA)?.status === 'pinged', 'cross-client check-in');
  await a.reducers.replyCheckin({ personId: MARIA, choice: 'cant_move', text: '' });
  await waitFor(() => [...a.db.task.iter()].some((t) => t.personId === MARIA), 'Maria help task');
  const task = [...a.db.task.iter()].find((t) => t.personId === MARIA)!;
  assert.equal(task.priority, 3);
  await a.reducers.replyCheckin({ personId: MARIA, choice: 'cant_move', text: '' });
  assert.equal([...a.db.task.iter()].filter((t) => t.personId === MARIA && !t.done).length, 1);
  const claims = await Promise.allSettled([
    a.reducers.claimTask({ taskId: task.id, staffName: 'Alex' }),
    b.reducers.claimTask({ taskId: task.id, staffName: 'Blair' }),
  ]);
  assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = claims[0].status === 'fulfilled' ? a : b, loser = winner === a ? b : a;
  await assert.rejects(loser.reducers.completeTask({ taskId: task.id }), /claiming staff member/);
  await winner.reducers.completeTask({ taskId: task.id });
  await waitFor(() => admin.db.person.id.find(MARIA)?.status === 'out', 'completed rescue');
  await assert.rejects(winner.reducers.completeTask({ taskId: task.id }), /already done/);
  await a.reducers.replyCheckin({ personId: ROBERT, choice: 'text', text: 'I need oxygen and cannot walk' });
  await assert.rejects(a.reducers.setReplyClass({ personId: ROBERT, choice: 'safe' }), /worker only/);
  await worker.reducers.setReplyClass({ personId: ROBERT, choice: 'needs_medical' });
  await waitFor(() => admin.db.person.id.find(ROBERT)?.status === 'cant_move', 'worker classification');
  assert.ok([...admin.db.task.iter()].some((t) => t.personId === ROBERT && !t.done && t.priority === 3), 'Robert has an urgent task');
  // Lantern's coach sends on-site staff at once (the engine then completes the rescue at the staff × van pace).
  const robertTask = [...admin.db.task.iter()].find((t) => t.personId === ROBERT && !t.done)!;
  // (on-site staff may claim him first on their own; either way he ends up with on-site staff)
  const assigned = await a.reducers.assignStaff({ taskId: robertTask.id }).then(() => null, (e: Error) => e.message);
  if (assigned && !/already claimed/.test(assigned)) throw new Error(assigned);
  await waitFor(() => admin.db.task.id.find(robertTask.id)!.claimedBy.endsWith(' · on-site'), 'on-site staff assigned to Robert');
  assert.ok(['claimed', 'out'].includes(admin.db.person.id.find(ROBERT)!.status));
  await assert.rejects(a.reducers.assignStaff({ taskId: robertTask.id }), /already claimed|already done/);
  // Fire engines: shared rows every screen draws; sent ahead of the fire, released back to staging.
  assert.equal(admin.db.unit.count(), 3n);
  await a.reducers.dispatchUnit({ buildingId: 12 });
  await waitFor(() => [...admin.db.unit.iter()].some((u) => u.targetId === 12 && u.status === 'enroute'), 'engine en route to Building 12');
  await assert.rejects(b.reducers.dispatchUnit({ buildingId: 12 }), /already assigned/);
  const shelter = [...admin.db.building.iter()].find((x) => x.kind === 'shelter')!;
  await assert.rejects(a.reducers.dispatchUnit({ buildingId: shelter.id }), /shelter/);
  const sent = [...admin.db.unit.iter()].find((u) => u.targetId === 12)!;
  await b.reducers.releaseUnit({ unitId: sent.id });
  await waitFor(() => admin.db.unit.id.find(sent.id)!.status !== 'enroute', 'engine released');
  await a.reducers.replyCheckin({ personId: MOBILE, choice: 'safe', text: '' });
  // The next tick may already walk a safe resident out; either way they are accounted for exactly once.
  await waitFor(() => ['safe', 'out'].includes(admin.db.person.id.find(MOBILE)!.status), 'safe confirmation');
  await Promise.allSettled([a.reducers.replyCheckin({ personId: MOBILE, choice: 'safe', text: '' })]);
  const b12 = admin.db.building.id.find(12)!;
  assert.ok(b12.peopleOut <= b12.residents, 'no double counting');
  assert.equal([...admin.db.task.iter()].filter((t) => t.personId === MOBILE && !t.done).length, 0);
  await admin.reducers.setSpeed({ minutesPerTick: 10 });
  await waitFor(() => [...admin.db.eventLog.iter()].some((e) => e.text.includes('no reply')), 'scheduled escalation');
  await waitFor(() => admin.db.sim.id.find(0)?.phase === 'ended', 'scheduled simulation end');
  assert.ok(admin.db.sim.id.find(0)!.tick > 0);
  assert.ok(admin.db.result.scenario.find('with_lantern'));
  await admin.reducers.runBaseline({});
  await waitFor(() => !!admin.db.result.scenario.find('without_lantern'), 'baseline result');
  assert.equal(admin.db.result.scenario.find('without_lantern')!.peopleTotal, 260);
  await admin.reducers.resetSim({});
  await waitFor(() => admin.db.sim.id.find(0)?.phase === 'prep', 'reset');
  assert.equal(admin.db.task.count(), 0n);
  assert.equal(admin.db.result.count(), 0n);
  assert.equal(admin.db.building.id.find(12)!.vans, 1);
  assert.ok([...admin.db.mitigation.iter()].every((m) => !/approved/.test(m.note)), 'reset restores the checklist');
  assert.equal(admin.db.sim.id.find(0)!.budgetLeft, 500000);
  assert.ok([...admin.db.unit.iter()].every((u) => u.status === 'ready' && u.targetId === 0), 'reset parks every engine');
  // Random scenarios: same town, new world; any client may roll one; reset replays it; 0 = the demo map.
  const demoRisks = [...admin.db.building.iter()].map((x) => x.baseRisk).join(',');
  await a.reducers.newScenario({ number: 4242 });
  await waitFor(() => admin.db.scenario.id.find(0)?.number === 4242, 'scenario row');
  await waitFor(() => [...admin.db.building.iter()].map((x) => x.baseRisk).join(',') !== demoRisks, 'buildings re-scored');
  assert.equal(admin.db.scenario.id.find(0)!.label, 'Scenario #4242');
  assert.equal(admin.db.sim.id.find(0)!.phase, 'prep');
  const scenarioRisks = [...admin.db.building.iter()].map((x) => x.baseRisk).join(',');
  await assert.rejects(a.reducers.setIgnition({ cellX: 999, cellY: 0 }), /nothing to burn/);
  const before = admin.db.scenario.id.find(0)!;
  await b.reducers.setIgnition({ cellX: 44, cellY: 3 });
  await waitFor(() => admin.db.scenario.id.find(0)!.picked, 'picked fire start');
  assert.notEqual(admin.db.scenario.id.find(0)!.ignitionX, before.ignitionX + 0.123);
  assert.equal([...admin.db.building.iter()].map((x) => x.baseRisk).join(','), scenarioRisks, 'moving the fire keeps the construction');
  await admin.reducers.resetSim({});
  await waitFor(() => admin.db.scenario.id.find(0)!.number === 4242 && admin.db.scenario.id.find(0)!.picked, 'reset keeps the scenario');
  await a.reducers.newScenario({ number: 0 });
  await waitFor(() => admin.db.scenario.id.find(0)!.number === 0, 'back to the demo map');
  assert.equal([...admin.db.building.iter()].map((x) => x.baseRisk).join(','), demoRisks);
  await admin.reducers.seedWorld({ json: JSON.stringify(readSeed()) });
  console.log('PASS: seed rollback, authorization, presence, insurer checklist, fixes, cross-client check-ins, atomic competing claims, rescue ownership, worker writes, coach staff assignment, fire engines, random scenarios and picked fire starts, scheduled escalation/end, baseline and reset.');
} finally {
  for (const c of clients) c.disconnect();
}
