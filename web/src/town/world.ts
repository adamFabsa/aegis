// The contract the UI renders from. Two implementations:
//   useLiveWorld()  — the real thing: SpacetimeDB tables + reducers (default)
//   useMockWorld()  — B's offline stand-in (?mock=1), handy when no server is reachable
import type { Building, FireCell, Person, Phase, ScenarioResult, Sim, Task } from './types';
import type { LogEvent, Unit } from './mockWorld';

export interface FixView {
  /** what onApprove receives back: the fix id (live) or a FixKey (mock) */
  key: string;
  name: string;
  cost: number;
  riskDrop: number;
  addVans: number;
  /** riskDrop comes from the fire simulation rather than the CAL FIRE model */
  simulated?: boolean;
}

export interface PreparedRule {
  riskMax: number;
  /** the fire arrival the evacuation has to beat (-1: the fire is not expected to reach it) */
  referenceEta: (b: Building) => number;
}

export type ConnectionState = { state: 'connecting' | 'live' | 'error'; server: string; message?: string };

/** Static per-building facts (building_profile table): business impact + data lineage. */
export interface BuildingProfile {
  /** share of 1,000 simulated Eaton-like fires that reach the building */
  reachProbability: number;
  roof: string;
  vents: string;
  eaves: string;
  windows: string;
  siding: string;
  yearBuilt: number;
  sources: string;
}

/** One insurer mitigation measure (mitigation table; California "Safer from Wildfires"). */
export interface Measure {
  measure: string;
  status: 'met' | 'missing' | 'unverified';
  fixId: number;
  note: string;
}

/** Live SpacetimeDB facts for the "running inside SpacetimeDB" chip. */
export interface LiveInfo {
  devices: number;
  workerOnline: boolean;
}

/** Errors come back as a message (null = ok). Live calls are async, mock calls are not. */
export type Result = string | null | Promise<string | null>;

export interface WorldApi {
  sim: Sim;
  buildings: Building[];
  cells: FireCell[];
  persons: Person[];
  tasks: Task[];
  events: LogEvent[];
  units: Unit[];
  approved: Record<number, string[]>;
  results?: { with: ScenarioResult; without: ScenarioResult };
  speed: 1 | 2 | 4;
  fixesFor: (buildingId: number) => FixView[];
  prepared: PreparedRule;
  connection?: ConnectionState;
  /** live only: per-building profile, insurer checklist and presence */
  profileFor?: (buildingId: number) => BuildingProfile | undefined;
  checklistFor?: (buildingId: number) => Measure[];
  live?: LiveInfo;
  setSpeed: (s: 1 | 2 | 4) => void;
  setPhase: (phase: Phase) => void;
  startEvacuation: (id: number) => void;
  approveFix: (id: number, key: string) => void;
  approveRecommended?: () => void;
  /** live only: Lantern's coach sends on-site staff to a waiting resident now */
  assignStaff?: (taskId: number) => Result;
  endAndCompare?: () => void;
  togglePause: () => void;
  reset: () => void;
  advance: (n: number) => void;
  dispatchUnit: (buildingId: number) => Result | void;
  releaseUnit: (unitId: number) => Result | void;
  replyCheckin: (personId: number, choice: 'safe' | 'cant_move' | 'text', text?: string) => Result | void;
  claimTask: (taskId: number, staffName: string) => Result;
  completeTask: (taskId: number) => Result | void;
}
