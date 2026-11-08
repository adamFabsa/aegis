// Row shapes that mirror the Spacetime tables in LANTERN_SPEC.md §4.
// When the generated bindings exist, swap these for the generated types
// (u64 columns arrive as bigint there, so wrap them with Number() before rendering).

export type Phase = 'prep' | 'fire' | 'ended';
export type BuildingKind = 'senior' | 'apartments' | 'office' | 'homes' | 'shelter';
export type BuildingStatus = 'ok' | 'behind' | 'evacuating' | 'clear' | 'burning' | 'lost';
export type Pack = 'night' | 'dusk' | 'maquette';

export interface Sim {
  phase: Phase;
  running: boolean;
  tick: number;
  simMinutes: number;
  minutesPerTick: number;
  budgetLeft: number;
  windDirDeg: number; // direction the wind blows TOWARD (225 = toward SW)
  windMph: number;
}

export interface Building {
  id: number;
  name: string;
  kind: BuildingKind;
  x: number;
  y: number;
  w: number;
  h: number;
  residents: number;
  needsHelp: number;
  staff: number;
  vans: number;
  valueUsd: number;
  risk: number;
  baseRisk: number;
  prepared: boolean;
  status: BuildingStatus;
  fireEtaMin: number;
  evacNeededMin: number;
  evacStarted: boolean;
  peopleOut: number;
  explanation: string;
  /** Client-side fire damage stage: 0 intact, 1 burning, 2 gutted (roof caved in), 3 collapsed. */
  damage?: number;
  /** 0..1 through the burn (smoke, growing fire, gutted, collapse). */
  burnProgress?: number;
}

export interface FireCell {
  id: number; // y * COLS + x
  x: number;
  y: number;
  fuel: number;
  state: number; // 0 unburned, 1 burning, 2 burned
  burnTicks: number;
}
