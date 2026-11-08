/**
 * SDK-free row types (Part C's names), now aliases of the engine's types in sim.ts so there is one source of
 * truth. Public rows match section 4 of the team contract field-for-field.
 */
export type {
  SimRow as Sim,
  BuildingRow as Building,
  PersonRow as Person,
  TaskRow as Task,
  FixRow as Fix,
  FireCellRow as FireCell,
  ResultRow as Result,
  World,
  Seed,
  FireParams,
} from './sim';
