/**
 * Admin seeding: `npm run seed -- [directory]` (default `seed/`). Reads the data pipeline's files
 * (buildings.json, people.json, fire_params.json — see data/README.md), validates them locally with the
 * module's own parseSeed, then sends one seed_world({json}) call as the administrator.
 * Not needed for a fresh publish: init already loads the same seed (bundled as seed_data.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { database, server } from './cli';
import { adminToken, connect } from './connect';
import { parseSeed } from '../spacetimedb/src/seed';

export function readSeed(directory = 'seed') {
  const read = (name: string) => JSON.parse(readFileSync(resolve(directory, `${name}.json`), 'utf8'));
  const unwrap = (v: unknown, key: string) => (Array.isArray(v) ? v : (v as Record<string, unknown>)[key]);
  const root = { buildings: unwrap(read('buildings'), 'buildings'), people: unwrap(read('people'), 'people'), params: read('fire_params') };
  return parseSeed(JSON.stringify(root));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/seed.ts')) {
  const seed = readSeed(process.argv[2]);
  const conn = await connect(adminToken());
  try {
    await conn.reducers.seedWorld({ json: JSON.stringify(seed) });
  } finally {
    conn.disconnect();
  }
  console.log(`Seeded ${seed.buildings.length} buildings / ${seed.people.length} people on ${server}/${database}`);
}
