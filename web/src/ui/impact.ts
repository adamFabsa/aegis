// Business impact, in dollars (CBRE: "quantify business impact"; State Farm: "fewer, smaller claims").
// Expected loss in an Eaton-like fire = building value × P(fire reaches it) × P(destroyed if reached).
//   P(reach): share of 1,000 calibrated fire simulations that reached the building (building_profile).
//   P(destroyed | reached): the building's risk, from the CAL FIRE DINS model (after approved fixes).
// It is conditional on such a fire starting (not an annual figure); dollar values are simulated.
import type { Building } from '../town/types';
import type { BuildingProfile, FixView } from '../town/world';

/** Risk floor the engine applies when fixes are approved (spacetimedb/src/sim.ts minRisk). */
const MIN_RISK = 5;

export function expectedLoss(b: Building, p: BuildingProfile | undefined, risk = b.risk): number | undefined {
  if (!p || b.kind === 'shelter') return undefined;
  return (b.valueUsd * p.reachProbability * risk) / 100;
}

/** Expected loss a fix would remove (0 for evacuation-only fixes such as a van). */
export function fixAvoids(b: Building, p: BuildingProfile | undefined, f: FixView): number {
  if (!p || f.riskDrop <= 0) return 0;
  const drop = Math.max(0, Math.min(f.riskDrop, b.risk - MIN_RISK));
  return (b.valueUsd * p.reachProbability * drop) / 100;
}

/** Portfolio expected loss now and before any fix (baseRisk). */
export function portfolio(buildings: Building[], profileFor?: (id: number) => BuildingProfile | undefined) {
  let now = 0;
  let before = 0;
  let known = false;
  for (const b of buildings) {
    const p = profileFor?.(b.id);
    const n = expectedLoss(b, p);
    const o = expectedLoss(b, p, b.baseRisk);
    if (n === undefined || o === undefined) continue;
    known = true;
    now += n;
    before += o;
  }
  return known ? { now, before, avoided: before - now } : undefined;
}
