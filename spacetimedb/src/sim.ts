/** Reference implementation of A's pure simulation contract. No DB, I/O, clock or global RNG.
 * Replace/tune this file with A; preserve World, stepSimulation and runBaseline signatures.
 * Map bearings: 0 north, 90 east, 180 south, 270 west (SVG y increases downward).
 */
import { emptyEngine, evacuationMinutes, initialSim, type Building, type FireCell, type Result, type Seed, type World } from './model';
export type Random = () => number;
const neighbors = [-1,0,1].flatMap(dy=>[-1,0,1].filter(dx=>dx!==0||dy!==0).map(dx=>[dx,dy] as const));
export function worldFromSeed(seed: Seed): World {
  return { sim: initialSim(seed), buildings:seed.buildings.map(b=>({...b})), people:seed.people.map(p=>({...p})),
    tasks:[],cells:seed.cells.map(c=>({...c})),params:{...seed.params},engine:emptyEngine() };
}
export function footprint(b: Building, cells: FireCell[]): FireCell[] {
  return cells.filter(c=>c.x*20 < b.x+b.w && (c.x+1)*20 > b.x && c.y*20 < b.y+b.h && (c.y+1)*20 > b.y);
}
function windFactor(dx: number, dy: number, world: World): number {
  const bearing = Math.atan2(dx,-dy);
  return Math.max(0.15,1+world.params.windK*Math.cos(bearing-world.sim.windDirDeg*Math.PI/180));
}
export function ignite(world: World): void {
  for (const id of world.params.ignitionCells) {
    const c=world.cells.find(c=>c.id===id);
    if(c && c.fuel>0) { c.state=1;c.burnTicks=0; }
  }
  computeEtas(world);
}
/** Binary heap Dijkstra, multi-source. Unburned fuel cells only; roads block adjacency. */
export function computeEtas(world: World): void {
  const byId=new Map(world.cells.map(c=>[c.id,c]));
  const distance=new Map<number,number>();
  const heap: [number,number][]=[];
  const push=(item:[number,number])=> {
    heap.push(item);let i=heap.length-1;
    while(i>0) { const p=(i-1)>>1;if(heap[p][0]<=item[0])break;heap[i]=heap[p];i=p; }heap[i]=item;
  };
  const pop=():[number,number]=> {
    const first=heap[0],last=heap.pop()!;
    if(heap.length) {let i=0;while(i*2+1<heap.length) {
      let c=i*2+1;if(c+1<heap.length&&heap[c+1][0]<heap[c][0])c++;
      if(heap[c][0]>=last[0])break;heap[i]=heap[c];i=c;
    }heap[i]=last;}return first;
  };
  for(const c of world.cells) if(c.state===1) { distance.set(c.id,0);push([0,c.id]); }
  while(heap.length) {
    const [d,id]=pop();if(d!==distance.get(id))continue;
    const c=byId.get(id)!;
    for(const [dx,dy] of neighbors) {
      const x=c.x+dx,y=c.y+dy;if(x<0||x>=50||y<0||y>=31)continue;
      const n=byId.get(y*50+x);if(!n||n.fuel<=0||n.state===2)continue;
      const cost=1/(world.params.baseSpread*n.fuel*windFactor(dx,dy,world));
      if(d+cost < (distance.get(n.id)??Infinity)) {distance.set(n.id,d+cost);push([d+cost,n.id]);}
    }
  }
  for(const b of world.buildings) {
    const best=Math.min(...footprint(b,world.cells).map(c=>distance.get(c.id)??Infinity));
    b.fireEtaMin=Number.isFinite(best)?best*world.sim.minutesPerTick:-1;
  }
}
export function addHelpTask(world: World, personId: number): boolean {
  if(world.tasks.some(t=>t.personId===personId&&!t.done&&t.kind==='help_person'))return false;
  const p=world.people.find(p=>p.id===personId)!;
  world.tasks.push({id:0n,kind:'help_person',buildingId:p.buildingId,personId,priority:3,
    claimedBy:'',done:false,createdTick:world.sim.tick});return true;
}
export function beginEvacuation(world: World, id: number): void {
  const b=world.buildings.find(b=>b.id===id)!;
  b.evacStarted=true;if(!['burning','lost','clear'].includes(b.status))b.status='evacuating';
  for(const p of world.people.filter(p=>p.buildingId===id&&p.status==='inside')) {
    p.status='pinged';p.pingedAtTick=world.sim.tick;
    world.engine.pingedAtMinute[p.id]=world.sim.simMinutes;
  }
}
export function summarize(world: World, scenario: string): Result {
  const damaged=world.buildings.filter(b=>world.engine.touched.includes(b.id));
  return { scenario,peopleSafe:world.people.filter(p=>p.status==='out'||p.status==='safe').length,
    peopleTotal:world.people.length,buildingsLost:world.buildings.filter(b=>b.status==='lost').length,
    damageUsd:damaged.reduce((n,b)=>n+b.valueUsd*(b.status==='lost'?1:0.3),0),claims:damaged.length };
}
export function refreshBuilding(world: World, b: Building): void {
  const residents=world.people.filter(p=>p.buildingId===b.id);
  b.peopleOut=residents.filter(p=>['safe','out'].includes(p.status)).length;
  const remainingHelp=residents.filter(p=>p.needsHelp&&!['safe','out','left_behind'].includes(p.status)).length;
  b.evacNeededMin=b.peopleOut===b.residents?0:evacuationMinutes(b,remainingHelp,world.params);
  if(!['burning','lost'].includes(b.status)) {
    b.status=b.peopleOut===b.residents?'clear':b.evacStarted?'evacuating':
      b.fireEtaMin>=0&&b.evacNeededMin>b.fireEtaMin?'behind':'ok';
  }
}
export interface StepOutput { world: World; events: string[]; ended: boolean }
/** Mutates only the supplied snapshot. DB adapter persists the changes atomically. */
export function stepSimulation(world: World, random: Random, baseline=false): StepOutput {
  if(!world.sim.running||world.sim.phase!=='fire')return {world,events:[],ended:false};
  const events:string[]=[];
  world.engine.elapsedAtTick[world.sim.tick]=world.sim.simMinutes;
  world.sim.tick++;world.sim.simMinutes+=world.sim.minutesPerTick;
  const byId=new Map(world.cells.map(c=>[c.id,c]));
  const burning=world.cells.filter(c=>c.state===1);
  const pending=new Set<number>();
  for(const c of burning) {
    for(const [dx,dy] of neighbors) {
      const x=c.x+dx,y=c.y+dy;if(x<0||x>=50||y<0||y>=31)continue;
      const n=byId.get(y*50+x);
      if(n&&n.state===0&&n.fuel>0&&random()<Math.min(1,world.params.baseSpread*n.fuel*windFactor(dx,dy,world)))pending.add(n.id);
    }
    if(c.fuel>=0.9&&random()<world.params.spotP*world.sim.windMph/40) {
      const distance=2+Math.floor(random()*3),rad=world.sim.windDirDeg*Math.PI/180;
      const x=Math.round(c.x+Math.sin(rad)*distance),y=Math.round(c.y-Math.cos(rad)*distance);
      if(x>=0&&x<50&&y>=0&&y<31) {
        const n=byId.get(y*50+x);if(n&&n.state===0&&n.fuel>0)pending.add(n.id);
      }
    }
    c.burnTicks++;if(c.burnTicks>=world.params.burnTicks)c.state=2;
  }
  for(const id of pending) {const c=byId.get(id)!;c.state=1;c.burnTicks=0;}
  if(world.sim.tick%5===0)computeEtas(world);
  for(const b of world.buildings) {
    if(baseline&&!b.evacStarted&&b.fireEtaMin>=0&&b.fireEtaMin<=10)beginEvacuation(world,b.id);
    const occupants=world.people.filter(p=>p.buildingId===b.id);
    // Silent/immobile residents require staff action before automated mobile departures.
    if(!baseline)for(const p of occupants) {
      const pingMinute=world.engine.pingedAtMinute[p.id]??world.engine.elapsedAtTick[p.pingedAtTick]??world.sim.simMinutes;
      if(p.status==='pinged'&&world.sim.simMinutes-pingMinute>=world.params.escalateMin) {
        p.status='cant_move';if(addHelpTask(world,p.id))events.push(`Escalated: ${p.name} (no reply)`);
      }
    }
    if(b.evacStarted&&b.status!=='lost') {
      // Mobile throughput clears the building in ~20 simulated minutes. A needs-help
      // resident marked safe is already accounted for; no task is needed to count them.
      const mobile=occupants.filter(p=>!p.needsHelp&&p.status==='pinged');
      const credit=(world.engine.evacuationCredit[b.id]??0)+Math.max(1,b.residents-b.needsHelp)*world.sim.minutesPerTick/20;
      const count=Math.min(mobile.length,Math.floor(credit));
      for(const p of mobile.slice(0,count))p.status='out';
      world.engine.evacuationCredit[b.id]=credit-count;
      if(baseline) {
        const key=`help-${b.id}`;
        const helpCredit=(world.engine.evacuationCredit[key]??0)+
          (b.staff*world.params.staffRate+b.vans*world.params.vanRate)*world.sim.minutesPerTick/60;
        const waiting=occupants.filter(p=>p.needsHelp&&p.status==='pinged');
        const moved=Math.min(waiting.length,Math.floor(helpCredit));
        waiting.slice(0,moved).forEach(p=>{p.status='out';});world.engine.evacuationCredit[key]=helpCredit-moved;
      }
    }
    const cells=footprint(b,world.cells);
    if(!['burning','lost'].includes(b.status)&&cells.some(c=>c.state===1)&&random()<b.risk/100*0.5) {
      b.status='burning';world.engine.burningSince[b.id]=world.sim.tick;
      if(!world.engine.touched.includes(b.id))world.engine.touched.push(b.id);
      events.push(`${b.name} ignited`);
    }
    if(b.status==='burning') {
      if(world.sim.tick-(world.engine.burningSince[b.id]??world.sim.tick)>=5) {
        b.status='lost';for(const p of occupants)if(!['safe','out'].includes(p.status))p.status='left_behind';
        for(const task of world.tasks)if(task.buildingId===b.id)task.done=true;
        events.push(`${b.name} lost`);
      } else for(const c of cells)if(c.fuel>0&&c.state===0) {c.state=1;c.burnTicks=0;}
    }
    refreshBuilding(world,b);
  }
  const ended=world.sim.tick>=world.params.maxTicks||
    (!world.cells.some(c=>c.state===1)&&!world.buildings.some(b=>b.status==='burning'))||
    world.buildings.every(b=>b.residents===0||['clear','lost'].includes(b.status));
  if(ended) {world.sim.phase='ended';world.sim.running=false;events.push('Simulation ended');}
  return {world,events,ended};
}
export function seededRandom(seed:number): Random {
  let s=seed>>>0;
  return ()=>{s=(Math.imul(1664525,s)+1013904223)>>>0;return s/4294967296;};
}
export function runBaseline(seed: Seed): Result {
  const world=worldFromSeed(seed);world.sim.phase='fire';world.sim.running=true;
  ignite(world);const random=seededRandom(seed.params.randomSeed);
  while(world.sim.running)stepSimulation(world,random,true);
  return summarize(world,'without_lantern');
}
