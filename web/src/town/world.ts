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
  setSpeed: (s: 1 | 2 | 4) => void;
  setPhase: (phase: Phase) => void;
  startEvacuation: (id: number) => void;
  approveFix: (id: number, key: string) => void;
  approveRecommended?: () => void;
  endAndCompare?: () => void;
  togglePause: () => void;
  reset: () => void;
  advance: (n: number) => void;
  dispatchUnit: (buildingId: number) => void;
  releaseUnit: (unitId: number) => void;
  replyCheckin: (personId: number, choice: 'safe' | 'cant_move' | 'text', text?: string) => Result | void;
  claimTask: (taskId: number, staffName: string) => Result;
  completeTask: (taskId: number) => Result | void;
}
