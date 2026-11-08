// Picks the demo fire seed: the most REPRESENTATIVE fire, not the most flattering one.
// Plays the scripted demo (van + brush on Building 12, van on Building 9, then the recommended fixes;
// evacuate 12/9/homes/7 at tick 2) on 40 fires, and picks the fire whose with-vs-without differences
// (people safe, buildings lost, damage) are closest to the 40-fire average. Writes it into
// data/out/calibration.json → re-run make_seed.ts.
//
//   node --experimental-strip-types data/sim/pick_demo_seed.ts && node --experimental-strip-types data/sim/make_seed.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { p_, readJson } from './seed_lib.ts';
import type { Calibration } from './seed_lib.ts';
import { buildWorldFromSeed, startFire, stepSimulation, computeResults, runBaseline, applyFix, startEvacuation, recommendFixes } from '../../spacetimedb/src/sim.ts';
import type { Seed, ResultRow } from '../../spacetimedb/src/sim.ts';

const R = (f: string) => JSON.parse(readFileSync(p_('seed', f), 'utf8'));
const seed: Seed = { buildings: R('buildings.json').buildings, people: R('people.json').people, params: R('fire_params.json') };
const p = seed.params;

function withLantern(fireSeed: number): ResultRow {
  const w = buildWorldFromSeed(seed);
  for (const [bid, name] of [[12, 'Second evacuation van'], [12, 'Clear brush to 30 ft'], [9, 'Second evacuation van']] as const) {
    const fx = w.fixes.find((f) => f.buildingId === bid && f.name === name);
    const b = w.buildings.find((x) => x.id === bid);
    if (fx && b) applyFix(w.sim, b, fx, w.people, p);
  }
  for (const id of recommendFixes(w, w.fixes, p)) {
    const fx = w.fixes.find((f) => f.id === id)!;
    applyFix(w.sim, w.buildings.find((b) => b.id === fx.buildingId)!, fx, w.people, p);
  }
  startFire(w, p, fireSeed);
  while (w.sim.phase === 'fire') {
    if (w.sim.tick === 2) for (const id of [12, 9, 20, 7]) startEvacuation(w, id, p);
    stepSimulation(w, p, fireSeed);
  }
  return computeResults(w, p, 'with_lantern');
}

const N = 40;
const rows: { s: number; dSafe: number; dLost: number; dDmg: number }[] = [];
for (let i = 0; i < N; i++) {
  const s = 20250107 + i;
  const a = withLantern(s);
  const b = runBaseline(seed, { fireSeed: s });
  rows.push({ s, dSafe: a.peopleSafe - b.peopleSafe, dLost: b.buildingsLost - a.buildingsLost, dDmg: (b.damageUsd - a.damageUsd) / 1e6 });
}
const mean = (k: 'dSafe' | 'dLost' | 'dDmg') => rows.reduce((t, r) => t + r[k], 0) / N;
const sd = (k: 'dSafe' | 'dLost' | 'dDmg') => Math.sqrt(rows.reduce((t, r) => t + (r[k] - mean(k)) ** 2, 0) / N) || 1;
const m = { dSafe: mean('dSafe'), dLost: mean('dLost'), dDmg: mean('dDmg') };
const dist = (r: (typeof rows)[number]) => ((r.dSafe - m.dSafe) / sd('dSafe')) ** 2 + ((r.dLost - m.dLost) / sd('dLost')) ** 2 + ((r.dDmg - m.dDmg) / sd('dDmg')) ** 2;
const best = rows.reduce((a, r) => (dist(r) < dist(a) ? r : a));
console.log(`average over ${N} fires: +${m.dSafe.toFixed(1)} people safe, ${m.dLost.toFixed(2)} fewer buildings lost, $${m.dDmg.toFixed(1)}M less damage`);
console.log(`representative fire: seed ${best.s} → +${best.dSafe} people, ${best.dLost} fewer buildings lost, $${best.dDmg.toFixed(1)}M less damage`);

const cal = readJson<Calibration>('data/out/calibration.json', {});
cal.params = { ...(cal.params ?? {}), fireSeed: best.s };
cal.report = { ...(cal.report ?? {}), demoSeed: { rule: 'fire closest to the 40-fire average with-vs-without difference', seed: best.s, average: m, chosen: best } };
writeFileSync(p_('data/out/calibration.json'), JSON.stringify(cal, null, 2) + '\n');
console.log('wrote fireSeed to data/out/calibration.json — re-run make_seed.ts');
