/** Integration test against a disposable database. Replaces its seed and resets at the end. */
import assert from 'node:assert/strict';
import { adminToken, connect, subscribe } from './connect';
import { readSeed } from './seed';
import type { DbConnection } from '../web/src/module_bindings';
const clients: DbConnection[]=[];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFor(test:()=>boolean,label:string,timeout=25000) {
  const start=Date.now();while(!test()) {if(Date.now()-start>timeout)throw new Error(`Timed out: ${label}`);await sleep(50);}
}
async function client(token?: string) {const c=await connect(token);clients.push(c);await subscribe(c);return c;}
try {
  const admin=await client(adminToken()),a=await client(),b=await client(),worker=await client();
  const seed=readSeed();seed.params.maxTicks=15;seed.params.burnTicks=200;
  seed.params.baseSpread=0.001;seed.params.spotP=0;
  await admin.reducers.seedWorld({json:JSON.stringify(seed)});
  await waitFor(()=>admin.db.person.count()===260n,'seed subscription');
  assert.equal(admin.db.fireCell.count(),1550n);
  assert.equal(admin.db.sim.id.find(0)!.phase,'prep');
  await assert.rejects(a.reducers.seedWorld({json:JSON.stringify(seed)}),/administrator only/);
  await assert.rejects(a.reducers.registerWorker({identity:a.identity!}),/administrator only/);
  await assert.rejects(a.reducers.setExplanation({buildingId:12,text:'bad'}),/worker only/);
  await admin.reducers.registerWorker({identity:worker.identity!});
  await worker.reducers.setExplanation({buildingId:12,text:'Simulated backend integration fixture.'});
  const initialBudget=admin.db.sim.id.find(0)!.budgetLeft;
  await admin.reducers.approveFix({fixId:121});
  await waitFor(()=>admin.db.fix.id.find(121)!.approved,'fix subscription');
  assert.equal(admin.db.building.id.find(12)!.vans,2);
  assert.equal(admin.db.sim.id.find(0)!.budgetLeft,initialBudget-48000);
  await assert.rejects(admin.reducers.approveFix({fixId:121}),/already approved/);
  const invalidSeed={...seed,people:[]};
  await assert.rejects(admin.reducers.seedWorld({json:JSON.stringify(invalidSeed)}),/Occupancy mismatch/);
  assert.equal(admin.db.fix.id.find(121)!.approved,true);
  await admin.reducers.setPhase({phase:'fire'});
  await assert.rejects(admin.reducers.approveFix({fixId:122}),/prep/);
  await assert.rejects(admin.reducers.setSpeed({minutesPerTick:0}),/1–60/);
  await admin.reducers.startEvacuation({buildingId:12});
  await waitFor(()=>a.db.person.id.find(1)?.status==='pinged','cross-client check-in');
  await a.reducers.replyCheckin({personId:1,choice:'cant_move',text:''});
  await waitFor(()=>[...a.db.task.iter()].some(t=>t.personId===1),'Maria help task');
  const task=[...a.db.task.iter()].find(t=>t.personId===1)!;
  await a.reducers.replyCheckin({personId:1,choice:'cant_move',text:''});
  assert.equal([...a.db.task.iter()].filter(t=>t.personId===1&&!t.done).length,1);
  const claims=await Promise.allSettled([
    a.reducers.claimTask({taskId:task.id,staffName:'Alex'}),
    b.reducers.claimTask({taskId:task.id,staffName:'Blair'}),
  ]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  const winner=claims[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
  await assert.rejects(loser.reducers.completeTask({taskId:task.id}),/claiming staff member/);
  await winner.reducers.completeTask({taskId:task.id});
  await waitFor(()=>admin.db.person.id.find(1)?.status==='out','completed rescue');
  await assert.rejects(winner.reducers.completeTask({taskId:task.id}),/already done/);
  await a.reducers.replyCheckin({personId:2,choice:'text',text:'I need oxygen and cannot walk'});
  await assert.rejects(a.reducers.setReplyClass({personId:2,choice:'safe'}),/worker only/);
  await worker.reducers.setReplyClass({personId:2,choice:'needs_medical'});
  await waitFor(()=>admin.db.person.id.find(2)?.status==='cant_move','worker classification');
  await a.reducers.replyCheckin({personId:3,choice:'safe',text:''});
  await waitFor(()=>admin.db.person.id.find(3)?.status==='safe','safe confirmation');
  const before=admin.db.building.id.find(12)!.peopleOut;
  await a.reducers.replyCheckin({personId:3,choice:'safe',text:''});
  assert.equal(admin.db.building.id.find(12)!.peopleOut,before);
  await admin.reducers.setSpeed({minutesPerTick:10});
  await waitFor(()=>[...admin.db.eventLog.iter()].some(e=>e.text.includes('(no reply)')),'scheduled escalation');
  await waitFor(()=>admin.db.sim.id.find(0)?.phase==='ended','scheduled simulation end');
  assert.ok(admin.db.sim.id.find(0)!.tick>0);
  assert.ok(admin.db.result.scenario.find('with_lantern'));
  await admin.reducers.runBaseline({});
  await waitFor(()=>!!admin.db.result.scenario.find('without_lantern'),'baseline result');
  assert.equal(admin.db.result.scenario.find('without_lantern')!.peopleTotal,260);
  await admin.reducers.resetSim({});
  await waitFor(()=>admin.db.sim.id.find(0)?.phase==='prep','reset');
  assert.equal(admin.db.task.count(),0n);assert.equal(admin.db.result.count(),0n);
  assert.equal(admin.db.building.id.find(12)!.vans,1);
  assert.equal(admin.db.sim.id.find(0)!.budgetLeft,500000);
  await admin.reducers.seedWorld({json:JSON.stringify(readSeed())});
  console.log('PASS: seed rollback, authorization, fixes, cross-client check-ins, atomic competing claims, rescue ownership, worker writes, scheduled escalation/end, baseline and reset.');
} finally {for(const c of clients)c.disconnect();}
