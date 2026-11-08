import { DEFAULT_PARAMS, evacuationMinutes, type Building, type FireCell, type Fix, type Person, type Seed } from './model';

type Obj = Record<string, unknown>;
function object(v: unknown, label: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be an object`);
  return v as Obj;
}
function number(o: Obj, key: string, fallback?: number, min = 0, max = 1e12, integer = false): number {
  const n = o[key] ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    throw new Error(`Invalid ${key}`);
  return n;
}
function str(o: Obj, key: string, fallback?: string): string {
  const v = o[key] ?? fallback;
  if (typeof v !== 'string' || v.length > 2000) throw new Error(`Invalid ${key}`);
  return v;
}
function array(v: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Invalid ${label}`);
  return v;
}
function unique(rows: {id: number}[], label: string) {
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error(`Duplicate ${label} id`);
}
/** Normalize A's files once, before any table is wiped. Never trust serialized game state. */
export function parseSeed(json: string): Seed {
  if (json.length > 4_000_000) throw new Error('Seed exceeds 4 MB');
  const root = object(JSON.parse(json), 'seed');
  const rawParams = object(root.params ?? root.fireParams ?? {}, 'params');
  const p = { ...DEFAULT_PARAMS };
  for (const key of Object.keys(p) as (keyof typeof p)[]) {
    if (key === 'ignitionCells') continue;
    (p as unknown as Obj)[key] = number(rawParams, key, p[key] as number);
  }
  if (p.baseSpread <= 0 || p.baseSpread > 1 || p.windK > 5 || p.spotP > 1 ||
    p.burnTicks < 1 || p.burnTicks > 255 || !Number.isInteger(p.burnTicks) ||
    p.maxTicks < 1 || p.maxTicks > 5000 || !Number.isInteger(p.maxTicks) ||
    p.escalateMin > 1440 || p.referenceFireEta <= 0 || p.windMph > 300 || p.windDirDeg >= 360)
    throw new Error('Invalid fire parameters');
  p.ignitionCells = array(rawParams.ignitionCells ?? p.ignitionCells, 'ignitionCells', 1550).map(v => {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= 1550) throw new Error('Invalid ignition cell');
    return v as number;
  });
  const buildings: Building[] = array(root.buildings, 'buildings', 100).map(v => {
    const o = object(v, 'building');
    const kind = str(o, 'kind');
    if (!['senior','apartments','office','homes','shelter'].includes(kind)) throw new Error('Invalid building kind');
    const b: Building = {
      id: number(o,'id',undefined,1,0xffffffff,true), name: str(o,'name'), kind,
      x: number(o,'x',undefined,0,1000), y: number(o,'y',undefined,0,620),
      w: number(o,'w',undefined,1,1000), h: number(o,'h',undefined,1,620),
      residents: number(o,'residents',undefined,0,10000,true), needsHelp: number(o,'needsHelp',undefined,0,10000,true),
      staff: number(o,'staff',undefined,0,1000,true), vans: number(o,'vans',undefined,0,1000,true),
      valueUsd: number(o,'valueUsd'), baseRisk: number(o,'baseRisk',undefined,0,100),
      risk: number(o,'baseRisk',undefined,0,100), prepared: false,
      status: 'ok', fireEtaMin: -1, evacNeededMin: 0, evacStarted: false, peopleOut: 0, explanation: '',
    };
    if (b.x+b.w > 1000 || b.y+b.h > 620 || b.needsHelp > b.residents) throw new Error('Invalid building footprint/occupancy');
    b.evacNeededMin = evacuationMinutes(b,b.needsHelp,p);
    return b;
  });
  if (!buildings.length) throw new Error('Seed needs buildings');
  unique(buildings,'building');
  const people: Person[] = array(root.people,'people',10000).map(v => {
    const o = object(v,'person');
    if (typeof o.needsHelp !== 'boolean') throw new Error('Invalid needsHelp');
    return { id: number(o,'id',undefined,1,0xffffffff,true), name: str(o,'name'),
      buildingId: number(o,'buildingId',undefined,1,0xffffffff,true), floor: number(o,'floor',1,0,255,true),
      needsHelp: o.needsHelp, note: str(o,'note',''), status: 'inside', pingedAtTick: 0, replyText: '' };
  });
  unique(people,'person');
  const ids = new Set(buildings.map(b=>b.id));
  if (people.some(p=>!ids.has(p.buildingId))) throw new Error('Person references missing building');
  for (const b of buildings) {
    const occupants = people.filter(p=>p.buildingId===b.id);
    if (occupants.length !== b.residents || occupants.filter(p=>p.needsHelp).length !== b.needsHelp)
      throw new Error(`Occupancy mismatch for building ${b.id}`);
  }
  const embedded = buildings.flatMap(b => {
    const original = (root.buildings as Obj[]).find(o=>o.id===b.id)!;
    return array(original.fixes ?? [],'fixes',100).map(v=>({...object(v,'fix'),buildingId:b.id}));
  });
  const fixes: Fix[] = array(root.fixes ?? embedded,'fixes',1000).map(v=> {
    const o = object(v,'fix');
    return { id:number(o,'id',undefined,1,0xffffffff,true),buildingId:number(o,'buildingId',undefined,1,0xffffffff,true),
      name:str(o,'name'),costUsd:number(o,'costUsd'),riskDrop:number(o,'riskDrop',0,0,100),
      addVans:number(o,'addVans',0,0,100,true),approved:false };
  });
  unique(fixes,'fix');
  if (fixes.some(f=>!ids.has(f.buildingId))) throw new Error('Fix references missing building');
  const cells: FireCell[] = array(root.cells ?? root.fireCells,'cells',1550).map(v=> {
    const o = object(v,'cell');
    const x=number(o,'x',undefined,0,49,true), y=number(o,'y',undefined,0,30,true);
    const id=number(o,'id',y*50+x,0,1549,true);
    if(id!==y*50+x) throw new Error('Cell id must equal y * 50 + x');
    return { id,x,y,fuel:number(o,'fuel',undefined,0,1),state:0,burnTicks:0 };
  });
  unique(cells,'cell');
  if(cells.length!==1550) throw new Error('Seed must include the complete 50 x 31 grid');
  if(!p.ignitionCells.length || p.ignitionCells.some(id=>!cells.some(c=>c.id===id && c.fuel>0)))
    throw new Error('Ignition cells must have fuel');
  return { buildings,people,fixes,cells,params:p,budget:number(root,'budget',500000),
    minutesPerTick:number(root,'minutesPerTick',2,1,60,true) };
}
