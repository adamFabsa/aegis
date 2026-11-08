import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { database, server } from './cli';
import { adminToken, connect } from './connect';
import { parseSeed } from '../spacetimedb/src/seed';
export function readSeed(directory='seed') {
  const read=(name: string)=>JSON.parse(readFileSync(resolve(directory,`${name}.json`),'utf8'));
  const root={buildings:read('buildings'),people:read('people'),params:read('fire_params'),
    cells:read('fire_cells'),...(existsSync(resolve(directory,'fixes.json'))?{fixes:read('fixes')}:{})};
  return parseSeed(JSON.stringify(root));
}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/seed.ts')) {
  const seed=readSeed(process.argv[2]);
  const conn=await connect(adminToken());
  try { await conn.reducers.seedWorld({json:JSON.stringify(seed)}); } finally {conn.disconnect();}
  console.log(`Seeded ${seed.buildings.length} buildings / ${seed.people.length} people on ${server}/${database}`);
}
