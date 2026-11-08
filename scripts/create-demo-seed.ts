/** Fictional fixtures for backend development; A replaces these with calibrated model output. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_PARAMS } from '../spacetimedb/src/model';
const rows = [
  [12,'Building 12','senior',570,250,150,70,38,9,4,1,82,8_000_000],
  [9,'Building 9','senior',780,300,110,60,22,6,3,1,78,6_000_000],
  [7,'Building 7','apartments',420,290,120,90,64,3,2,0,66,9_000_000],
  [3,'Building 3','apartments',170,270,140,80,80,4,2,0,52,10_000_000],
  [15,'Building 15','office',140,480,130,64,12,0,1,0,42,4_000_000],
  [10,'Building 10','apartments',800,470,130,70,30,2,1,0,62,5_000_000],
  [20,'Hillside homes','homes',430,150,280,40,14,2,0,0,90,3_000_000],
  [99,'Shelter A','shelter',440,505,140,60,0,0,2,0,10,2_000_000],
] as const;
const buildings=rows.map(([id,name,kind,x,y,w,h,residents,needsHelp,staff,vans,baseRisk,valueUsd])=>
  ({id,name,kind,x,y,w,h,residents,needsHelp,staff,vans,baseRisk,valueUsd,
    simulated:true,features:{roof:'simulated',brushDistanceFt:5},fixes:[
      {id:id*10+1,name:'Second evacuation van',costUsd:48000,riskDrop:0,addVans:1},
      {id:id*10+2,name:'Clear brush to 30 ft',costUsd:12000,riskDrop:45,addVans:0},
      {id:id*10+3,name:'Ember-resistant vent screens',costUsd:9000,riskDrop:18,addVans:0},
      {id:id*10+4,name:'Class A roof',costUsd:140000,riskDrop:25,addVans:0},
    ]}));
let personId=1;
const people=buildings.flatMap(b=>Array.from({length:b.residents},(_,i)=>({
  id:personId++,buildingId:b.id,name:b.id===12&&i===0?'Maria R.':b.id===12&&i===1?'Robert K.':`Resident ${b.id}-${i+1}`,
  floor:b.id===12&&i===0?3:b.id===12&&i===1?2:1+i%4,
  needsHelp:i<b.needsHelp,note:b.id===12&&i===0?'wheelchair':b.id===12&&i===1?'oxygen':i<b.needsHelp?'mobility assistance':'',
})));
const cells=Array.from({length:1550},(_,id)=> {
  const x=id%50,y=Math.floor(id/50),px=x*20+10,py=y*20+10;
  const b=buildings.find(b=>px>=b.x&&px<b.x+b.w&&py>=b.y&&py<b.y+b.h);
  const road=(py>=430&&py<=466)||(px>=360&&px<=392)||(py>=214&&py<=236&&px>=392);
  // Approximation for development only; A supplies the exact geometry/calibrated fuel.
  const hill=px>=560&&py<Math.max(0,(px-560)*0.64);
  return {id,x,y,fuel:b?(b.kind==='shelter'?0.1:0.6):road?0:hill?1:0.35};
});
mkdirSync('seed',{recursive:true});
for(const [name,value] of Object.entries({buildings,people,fire_cells:cells,fire_params:DEFAULT_PARAMS}))
  writeFileSync(`seed/${name}.json`,JSON.stringify(value,null,2)+'\n');
