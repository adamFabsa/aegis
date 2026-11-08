import { ScheduleAt } from 'spacetimedb';
import { t, SenderError, type ReducerCtx } from 'spacetimedb/server';
import db, { simTick } from './schema';
import { parseSeed } from './seed';
import { emptyEngine, initialSim, type EngineState, type Seed, type World } from './model';
import { addHelpTask, beginEvacuation, computeEtas, ignite, refreshBuilding, runBaseline, stepSimulation, summarize, worldFromSeed } from './sim';
export default db;
type Context = ReducerCtx<typeof db.schemaType>;

function reject(message: string): never { throw new SenderError(message); }
function requireAdmin(ctx: Context) {
  if(!ctx.db.admin.id.find(0)?.identity.isEqual(ctx.sender))reject('administrator only');
}
function requireWorker(ctx: Context) {
  if(!ctx.db.admin.id.find(0)?.worker?.isEqual(ctx.sender))reject('worker only');
}
function getSim(ctx: Context) {return ctx.db.sim.id.find(0)??reject('simulation not initialized');}
function requireFire(ctx: Context) {if(getSim(ctx).phase!=='fire')reject('fire phase required');}
function storedSeed(ctx: Context): Seed {return parseSeed(ctx.db.worldSeed.id.find(0)?.json??reject('seed world first'));}
function log(ctx: Context,text: string) {ctx.db.eventLog.insert({id:0n,tick:getSim(ctx).tick,text});}
function load(ctx: Context): World {
  const seed=storedSeed(ctx);
  return {sim:{...getSim(ctx)},buildings:[...ctx.db.building.iter()].map(b=>({...b})),
    people:[...ctx.db.person.iter()].map(p=>({...p})),tasks:[...ctx.db.task.iter()].map(t=>({...t})),
    cells:[...ctx.db.fireCell.iter()].map(c=>({...c})),params:seed.params,
    engine:JSON.parse(ctx.db.engineState.id.find(0)?.json??JSON.stringify(emptyEngine())) as EngineState};
}
function persist(ctx: Context,world: World) {
  // Only changed rows generate subscription traffic. New tasks get DB auto-increment IDs.
  function differs(a: unknown,b: unknown) {return JSON.stringify(a,(_k,v)=>typeof v==='bigint'?v.toString():v)!==JSON.stringify(b,(_k,v)=>typeof v==='bigint'?v.toString():v);}
  if(differs(getSim(ctx),world.sim))ctx.db.sim.id.update(world.sim);
  for(const b of world.buildings)if(differs(ctx.db.building.id.find(b.id),b))ctx.db.building.id.update(b);
  for(const p of world.people)if(differs(ctx.db.person.id.find(p.id),p))ctx.db.person.id.update(p);
  for(const c of world.cells)if(differs(ctx.db.fireCell.id.find(c.id),c))ctx.db.fireCell.id.update(c);
  for(const task of world.tasks) {
    if(task.id===0n)ctx.db.task.insert(task);
    else if(differs(ctx.db.task.id.find(task.id),task))ctx.db.task.id.update(task);
  }
  const engine={id:0,json:JSON.stringify(world.engine)};
  if(ctx.db.engineState.id.find(0))ctx.db.engineState.id.update(engine);else ctx.db.engineState.insert(engine);
}
function seedWorld(ctx: Context,seed: Seed) {
  for(const b of ctx.db.building.iter())ctx.db.building.id.delete(b.id);
  for(const p of ctx.db.person.iter())ctx.db.person.id.delete(p.id);
  for(const f of ctx.db.fix.iter())ctx.db.fix.id.delete(f.id);
  for(const c of ctx.db.fireCell.iter())ctx.db.fireCell.id.delete(c.id);
  for(const t of ctx.db.task.iter())ctx.db.task.id.delete(t.id);
  for(const e of ctx.db.eventLog.iter())ctx.db.eventLog.id.delete(e.id);
  for(const r of ctx.db.result.iter())ctx.db.result.scenario.delete(r.scenario);
  for(const o of ctx.db.taskOwner.iter())ctx.db.taskOwner.taskId.delete(o.taskId);
  ctx.db.sim.id.update(initialSim(seed));
  for(const b of seed.buildings)ctx.db.building.insert(b);
  for(const p of seed.people)ctx.db.person.insert(p);
  for(const f of seed.fixes)ctx.db.fix.insert(f);
  for(const c of seed.cells)ctx.db.fireCell.insert(c);
  const engine={id:0,json:JSON.stringify(emptyEngine())};
  if(ctx.db.engineState.id.find(0))ctx.db.engineState.id.update(engine);else ctx.db.engineState.insert(engine);
  log(ctx,'World seeded · fictional neighborhood, simulated values');
}
export const init = db.init(ctx=> {
  ctx.db.admin.insert({id:0,identity:ctx.sender,worker:undefined});
  ctx.db.sim.insert(initialSim());
  ctx.db.simTick.insert({scheduledId:0n,scheduledAt:ScheduleAt.interval(1_000_000n)});
});
export const seed_world = db.reducer({json:t.string()},(ctx,{json})=> {
  requireAdmin(ctx);
  let seed: Seed;
  try {seed=parseSeed(json);}catch(error) {reject(`Invalid seed: ${(error as Error).message}`);}
  const row={id:0,json:JSON.stringify(seed)};
  if(ctx.db.worldSeed.id.find(0))ctx.db.worldSeed.id.update(row);else ctx.db.worldSeed.insert(row);
  seedWorld(ctx,seed);
});
export const register_worker = db.reducer({identity:t.identity()},(ctx,{identity})=> {
  requireAdmin(ctx);const admin=ctx.db.admin.id.find(0)!;
  ctx.db.admin.id.update({...admin,worker:identity});log(ctx,'Worker identity registered');
});
export const reset_sim = db.reducer(ctx=> {seedWorld(ctx,storedSeed(ctx));});
export const set_phase = db.reducer({phase:t.string()},(ctx,{phase})=> {
  if(!['prep','fire'].includes(phase))reject('phase must be prep or fire');
  if(phase==='prep') {seedWorld(ctx,storedSeed(ctx));return;}
  const world=load(ctx);
  if(world.sim.phase!=='prep')reject('reset to prep before starting another fire');
  world.sim.phase='fire';world.sim.running=true;ignite(world);
  for(const b of world.buildings)refreshBuilding(world,b);
  persist(ctx,world);log(ctx,'Fire started · simulated wildfire scenario');
});
export const set_speed = db.reducer({minutesPerTick:t.u32()},(ctx,{minutesPerTick})=> {
  if(minutesPerTick<1||minutesPerTick>60)reject('minutesPerTick must be 1–60');
  const world=load(ctx);world.sim.minutesPerTick=minutesPerTick;
  if(world.sim.phase==='fire')computeEtas(world);
  persist(ctx,world);
});
export const approve_fix = db.reducer({fixId:t.u32()},(ctx,{fixId})=> {
  if(getSim(ctx).phase!=='prep')reject('fixes can only be approved in prep');
  const fix=ctx.db.fix.id.find(fixId)??reject('fix not found');
  if(fix.approved)reject('fix already approved');
  const world=load(ctx);
  if(fix.costUsd>world.sim.budgetLeft)reject('insufficient budget');
  const b=world.buildings.find(b=>b.id===fix.buildingId)??reject('building not found');
  world.sim.budgetLeft-=fix.costUsd;b.risk=Math.max(5,b.risk-fix.riskDrop);b.vans+=fix.addVans;
  refreshBuilding(world,b);b.prepared=b.risk<40&&b.evacNeededMin<world.params.referenceFireEta;
  ctx.db.fix.id.update({...fix,approved:true});persist(ctx,world);log(ctx,`Approved ${fix.name} for ${b.name}`);
});
export const start_evacuation = db.reducer({buildingId:t.u32()},(ctx,{buildingId})=> {
  requireFire(ctx);const world=load(ctx);
  const b=world.buildings.find(b=>b.id===buildingId)??reject('building not found');
  if(b.evacStarted||['lost','clear'].includes(b.status)||b.residents===0)reject('building cannot start evacuation');
  beginEvacuation(world,b.id);persist(ctx,world);log(ctx,`Evacuation started: ${b.name}`);
});
function reply(ctx: Context,personId: number,choice: string,text: string,worker=false) {
  requireFire(ctx);
  if(!['safe','cant_move','text','needs_medical','unclear'].includes(choice)||(!worker&&!['safe','cant_move','text'].includes(choice)))reject('invalid check-in choice');
  if(text.length>2000)reject('reply exceeds 2000 characters');
  const world=load(ctx),p=world.people.find(p=>p.id===personId)??reject('person not found');
  if(['out','left_behind','inside'].includes(p.status))reject('person cannot reply in current state');
  if(worker && (!p.replyText||p.status!=='pinged'))reject('no pending text reply');
  if(choice==='text') {
    if(!text.trim())reject('reply text is empty');
    if(p.status!=='pinged')reject('text reply requires pending check-in');p.replyText=text.trim();
  }else if(choice==='unclear') {
    // Preserve pinged state so the ordinary silent-resident deadline still applies.
  }else if(choice==='safe') {
    if(p.status==='safe')return;
    // A late classifier cannot undo staff work; direct resident confirmations can.
    p.status='safe';p.replyText=worker?p.replyText:text;
    for(const task of world.tasks)if(task.personId===p.id&&!task.done)task.done=true;
  }else {
    if(p.status==='safe')reject('resident already safe');
    if(p.status!=='claimed')p.status='cant_move';
    p.replyText=worker?p.replyText:text;addHelpTask(world,p.id);
  }
  const b=world.buildings.find(b=>b.id===p.buildingId)!;refreshBuilding(world,b);
  persist(ctx,world);log(ctx,`${p.name}: ${choice==='needs_medical'?'needs medical assistance':choice}`);
}
export const reply_checkin = db.reducer({personId:t.u32(),choice:t.string(),text:t.string()},(ctx,args)=>reply(ctx,args.personId,args.choice,args.text));
export const set_reply_class = db.reducer({personId:t.u32(),choice:t.string()},(ctx,{personId,choice})=> {
  requireWorker(ctx);if(choice==='text')reject('worker must classify text');reply(ctx,personId,choice,'',true);
});
export const set_explanation = db.reducer({buildingId:t.u32(),text:t.string()},(ctx,{buildingId,text})=> {
  requireWorker(ctx);if(text.length>2000)reject('explanation exceeds 2000 characters');
  const b=ctx.db.building.id.find(buildingId)??reject('building not found');ctx.db.building.id.update({...b,explanation:text});
});
export const claim_task = db.reducer({taskId:t.u64(),staffName:t.string()},(ctx,{taskId,staffName})=> {
  requireFire(ctx);if(!staffName.trim()||staffName.length>80)reject('staff name must be 1–80 characters');
  const task=ctx.db.task.id.find(taskId)??reject('task not found');
  if(task.claimedBy!=='')reject('already claimed');if(task.done)reject('task already done');
  const p=task.personId?ctx.db.person.id.find(task.personId):undefined;
  if(p&&['safe','out','left_behind'].includes(p.status))reject('resident no longer needs help');
  ctx.db.task.id.update({...task,claimedBy:staffName.trim()});
  ctx.db.taskOwner.insert({taskId,identity:ctx.sender});
  if(p)ctx.db.person.id.update({...p,status:'claimed'});
  log(ctx,`${staffName.trim()} claimed ${p?.name??task.kind}`);
});
export const complete_task = db.reducer({taskId:t.u64()},(ctx,{taskId})=> {
  requireFire(ctx);const task=ctx.db.task.id.find(taskId)??reject('task not found');
  if(!task.claimedBy)reject('claim task first');
  if(!ctx.db.taskOwner.taskId.find(taskId)?.identity.isEqual(ctx.sender))reject('only the claiming staff member can complete this task');
  if(task.done)reject('task already done');
  const world=load(ctx),t=world.tasks.find(t=>t.id===taskId)!;t.done=true;
  if(t.personId) {
    const p=world.people.find(p=>p.id===t.personId)??reject('person not found');
    if(p.status==='left_behind')reject('resident cannot be evacuated from a lost building');
    if(!['safe','out'].includes(p.status))p.status='out';
    refreshBuilding(world,world.buildings.find(b=>b.id===p.buildingId)!);
  }
  persist(ctx,world);log(ctx,`${task.claimedBy} completed ${task.kind}`);
});
export const run_baseline = db.reducer(ctx=> {
  if(getSim(ctx).phase!=='ended')reject('simulation must end before baseline');
  if(ctx.db.result.scenario.find('without_lantern'))return;
  ctx.db.result.insert(runBaseline(storedSeed(ctx)));log(ctx,'Without Lantern comparison complete');
});
export const tick = db.reducer({onSchedule:simTick},{arg:simTick.rowType},(ctx,_args)=> {
  if(!getSim(ctx).running)return;
  const output=stepSimulation(load(ctx),()=>ctx.random());persist(ctx,output.world);
  for(const event of output.events)log(ctx,event);
  if(output.ended) {
    const row=summarize(output.world,'with_lantern');
    if(ctx.db.result.scenario.find(row.scenario))ctx.db.result.scenario.update(row);else ctx.db.result.insert(row);
  }
});
