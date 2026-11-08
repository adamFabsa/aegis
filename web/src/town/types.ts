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
  /** Client-side: the building caught fire at some point (counts toward damage even if saved). */
  touched?: boolean;
}

export interface FireCell {
  id: number; // y * COLS + x
  x: number;
  y: number;
  fuel: number;
  state: number; // 0 unburned, 1 burning, 2 burned
  burnTicks: number;
}

/** Mirrors the spec's person table (plus `plan`, which only the mock uses to fake replies). */
export type PersonStatus = 'inside' | 'pinged' | 'safe' | 'cant_move' | 'claimed' | 'out' | 'left_behind';
export interface Person {
  id: number;
  name: string;
  buildingId: number;
  floor: number;
  needsHelp: boolean;
  note: string;
  status: PersonStatus;
  pingedAtTick: number;
  replyText: string;
  /** mock only: how this resident answers the ping if nobody uses the phone, and when */
  plan?: 'safe' | 'cant' | 'silent';
  replyAt?: number;
  escalated?: boolean;
}

/** Mirrors the spec's task table. */
export interface Task {
  id: number;
  kind: 'help_person';
  buildingId: number;
  personId: number;
  priority: number;
  claimedBy: string;
  done: boolean;
  createdTick: number;
  /** mock only: claimed by simulated staff, completed automatically at the staff/van rate */
  auto?: boolean;
}

/** The frame the map just left (look, phase, buildings, fire cells): dissolved over the new one for a moment. */
export interface Ghost { pack: Pack; phase: Phase; buildings: Building[]; cells: FireCell[]; epoch: number }

/** Mirrors the spec's result table. */
export interface ScenarioResult { peopleSafe: number; peopleTotal: number; buildingsLost: number; damageUsd: number; claims: number }
