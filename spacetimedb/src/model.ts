/** Public row types match section 4 of the team contract. No SDK/runtime imports. */
export interface Sim {
  id: number; phase: string; running: boolean; tick: number; simMinutes: number;
  minutesPerTick: number; budgetLeft: number; windDirDeg: number; windMph: number;
}
export interface Building {
  id: number; name: string; kind: string; x: number; y: number; w: number; h: number;
  residents: number; needsHelp: number; staff: number; vans: number; valueUsd: number;
  risk: number; baseRisk: number; prepared: boolean; status: string; fireEtaMin: number;
  evacNeededMin: number; evacStarted: boolean; peopleOut: number; explanation: string;
}
export interface Person {
  id: number; name: string; buildingId: number; floor: number; needsHelp: boolean;
  note: string; status: string; pingedAtTick: number; replyText: string;
}
export interface Task {
  id: bigint; kind: string; buildingId: number; personId: number; priority: number;
  claimedBy: string; done: boolean; createdTick: number;
}
export interface Fix {
  id: number; buildingId: number; name: string; costUsd: number; riskDrop: number;
  addVans: number; approved: boolean;
}
export interface FireCell { id: number; x: number; y: number; fuel: number; state: number; burnTicks: number }
export interface Result {
  scenario: string; peopleSafe: number; peopleTotal: number; buildingsLost: number;
  damageUsd: number; claims: number;
}
export interface FireParams {
  baseSpread: number; windK: number; spotP: number; burnTicks: number;
  windDirDeg: number; windMph: number; ignitionCells: number[];
  staffRate: number; vanRate: number; escalateMin: number; referenceFireEta: number;
  maxTicks: number; randomSeed: number;
}
/** Private state preserves timing across speed changes and scheduled invocations. */
export interface EngineState {
  burningSince: Record<string, number>;
  touched: number[];
  evacuationCredit: Record<string, number>;
  pingedAtMinute: Record<string, number>;
  elapsedAtTick: Record<string, number>;
}
export interface World {
  sim: Sim; buildings: Building[]; people: Person[]; tasks: Task[]; cells: FireCell[];
  params: FireParams; engine: EngineState;
}
export interface Seed { buildings: Building[]; people: Person[]; fixes: Fix[]; cells: FireCell[];
  params: FireParams; budget: number; minutesPerTick: number }
export const DEFAULT_PARAMS: FireParams = {
  baseSpread: 0.30, windK: 1.4, spotP: 0.02, burnTicks: 3,
  windDirDeg: 225, windMph: 40, ignitionCells: [48, 49, 98, 99],
  staffRate: 0.5, vanRate: 2, escalateMin: 10, referenceFireEta: 180,
  maxTicks: 1500, randomSeed: 2026,
};
export function emptyEngine(): EngineState {
  return { burningSince: {}, touched: [], evacuationCredit: {}, pingedAtMinute: {}, elapsedAtTick: {} };
}
export function evacuationMinutes(building: Building, remaining = building.needsHelp, params = DEFAULT_PARAMS): number {
  if (building.residents === 0) return 0;
  if (remaining === 0) return 20;
  const capacity = params.staffRate * building.staff + params.vanRate * building.vans;
  // Finite sentinel because f64 Infinity/NaN are unsuitable for UI/JSON transport.
  return capacity > 0 ? 20 + 60 * remaining / capacity : 1_000_000;
}
export function initialSim(seed?: Seed): Sim {
  return { id: 0, phase: 'prep', running: false, tick: 0, simMinutes: 0,
    minutesPerTick: seed?.minutesPerTick ?? 2, budgetLeft: seed?.budget ?? 500_000,
    windDirDeg: seed?.params.windDirDeg ?? 225, windMph: seed?.params.windMph ?? 40 };
}
