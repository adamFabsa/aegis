# Part C backend contract

## State and generated bindings

The eight public tables exactly match section 4 of the build spec: `sim`, `building`, `person`, `task`, `fix`, `fire_cell`, `event_log`, `result`. `sim.id` is always 0. The private `sim_tick` row schedules `tick` once per 1,000,000 microseconds. Initialization creates one schedule, and reset/reseed preserves it. Scheduled reducer calls are private in SpacetimeDB 2.14.1, and `tick` is omitted from client bindings.

Public table accessors and reducer methods in generated TypeScript are **camelCase**, while SQL table names and wire reducer names are **snake_case**. Columns retain the specified camelCase names. Task and event IDs, and SDK table `count()`, are `bigint`.

```ts
import { DbConnection } from './module_bindings';

const connection = DbConnection.builder()
  .withUri('http://127.0.0.1:3000')
  .withDatabaseName('lantern')
  .withToken(localStorage.getItem('lantern-token') ?? undefined)
  .onConnect((conn, identity, token) => {
    localStorage.setItem('lantern-token', token);
    conn.subscriptionBuilder()
      .onApplied(() => {
        // All public tables now have an initial snapshot; render from conn.db.
        const sim = conn.db.sim.id.find(0);
      })
      .subscribeToAllTables();
  })
  .build();

await connection.reducers.approveFix({ fixId: 121 });
await connection.reducers.setPhase({ phase: 'fire' });
await connection.reducers.startEvacuation({ buildingId: 12 });
await connection.reducers.replyCheckin({ personId: 1, choice: 'cant_move', text: '' });
// Subscribe before looking up task IDs; they are database-generated, never fixed constants.
const task = [...connection.db.task.iter()].find(t => t.personId === 1 && !t.done);
if (task) {
  await connection.reducers.claimTask({ taskId: task.id, staffName: 'Alex' });
  await connection.reducers.completeTask({ taskId: task.id });
}
```

The examples use generated bindings directly; B may use the SDK's React provider/hooks with the same bindings. Copy readonly rows before sorting. Catch reducer promise rejections and show their messages (especially `already claimed`). Persist staff connection tokens so reconnecting preserves the identity needed to complete claimed tasks.

## Reducers

| Wire name / generated method | Arguments | Rules |
| --- | --- | --- |
| `seed_world` / `seedWorld` | `{json: string}` | Administrator only. Validate before replacing state; store original seed privately. |
| `register_worker` / `registerWorker` | `{identity: Identity}` | Administrator only. Set or rotate the authorized worker identity. |
| `set_phase` / `setPhase` | `{phase: 'prep' \| 'fire'}` | Prep restores seed and clears the prior run, including approved fixes. Fire requires prep, ignites seed cells and enables ticking. |
| `set_speed` / `setSpeed` | `{minutesPerTick: number}` | Integer 1–60; recomputes current ETAs. |
| `approve_fix` / `approveFix` | `{fixId: number}` | Prep only; reject duplicates/insufficient budget; apply risk floor 5 and van increase; recompute evacuation/prepared status. |
| `start_evacuation` / `startEvacuation` | `{buildingId: number}` | Fire only; reject duplicate starts, empty/clear/lost buildings; ping people still inside. |
| `reply_checkin` / `replyCheckin` | `{personId: number, choice: string, text: string}` | Fire only; choices `safe`, `cant_move`, `text`; max 2000 characters. Requires an active check-in. |
| `set_reply_class` / `setReplyClass` | `{personId: number, choice: string}` | Registered worker only; `safe`, `cant_move`, `needs_medical`, `unclear`. Only pending text on a pinged person may be classified. |
| `set_explanation` / `setExplanation` | `{buildingId: number, text: string}` | Registered worker only; max 2000 characters. |
| `claim_task` / `claimTask` | `{taskId: bigint, staffName: string}` | Fire only; reject done/already-claimed tasks; staff name 1–80 characters. Claim and identity ownership commit atomically. |
| `complete_task` / `completeTask` | `{taskId: bigint}` | Fire only; require the claiming identity; reject repeated completion; mark person out and recompute peopleOut from residents. |
| `run_baseline` / `runBaseline` | `{}` | Ended only; deterministic no-fixes/no-escalation run from original seed; idempotent. |
| `reset_sim` / `resetSim` | `{}` | Restore original seed, budget, people, grid and fixes; remove tasks/events/results; preserve worker registration and schedule. |

Dashboard/staff/resident actions are intentionally shared demo controls, as requested; there is no production resident account or building access model. Anyone with access to the demo can reset or start it. Seed replacement and worker registration require the original publishing identity. Staff names are display labels; identity, rather than a matching name, authorizes completion.

Safe replies immediately account for the resident and close obsolete help tasks. Safe replies and rescue completion cannot double-count a person. Repeated `cant_move` replies never create duplicate open help tasks. Classifier `needs_medical` maps to urgent assistance; `unclear` retains the pending check-in and the original escalation deadline. Workers should process each `(personId, replyText)` once and skip anyone no longer pinged. A delayed classification that races a newer free-text reply cannot be version-checked through the fixed two-argument worker reducer, so D should serialize per-person classifications.

## A's seed input

`npm run seed -- <directory>` loads `buildings.json`, `people.json`, `fire_cells.json`, `fire_params.json`, and optional `fixes.json`. It normalizes and validates locally, then sends one `seed_world({json})` call through the generated SDK, avoiding OS argument-size limits. The same validation runs in the reducer, so malformed seeds roll back atomically.

The reducer accepts a JSON object:

```ts
{
  buildings: Array<{
    id, name, kind, x, y, w, h, residents, needsHelp, staff, vans, valueUsd, baseRisk,
    fixes?: Array<{id, name, costUsd, riskDrop, addVans}>
  }>,
  people: Array<{id, name, buildingId, floor, needsHelp, note}>,
  cells: Array<{id, x, y, fuel}>,
  fixes?: Array<{id, buildingId, name, costUsd, riskDrop, addVans}>,
  params: {
    baseSpread: 0.30, windK: 1.4, spotP: 0.02, burnTicks: 3,
    windDirDeg: 225, windMph: 40, ignitionCells: [48,49,98,99],
    staffRate: 0.5, vanRate: 2, escalateMin: 10, referenceFireEta: 180,
    maxTicks: 1500, randomSeed: 2026
  },
  budget?: 500000, minutesPerTick?: 2
}
```

The sample above describes object keys (not literal JSON). Runtime defaults for params come from `model.ts`; all provided numeric values must be finite and valid. `fireParams` is accepted as an alias for `params`; `fireCells` for `cells`. Cell IDs must equal `y*50+x` over the complete 50×31 grid. All IDs must be unique, references valid, building counts must match people exactly, and each ignition cell must have fuel. Invalid seeds leave the current world intact.

Dynamic fields (statuses, risk after fixes, approved flags, peopleOut, etc.) are reset during normalization, never trusted from input. Model features can remain in A's raw file; the fixed public schema exposes only baseRisk/risk and explanation. Source files should stay available to D for explanation inputs.

## A's simulation interface

`model.ts` defines SDK-free row types plus `World` and `EngineState`. The reference engine exports:

```ts
worldFromSeed(seed: Seed): World
ignite(world: World): void
computeEtas(world: World): void
beginEvacuation(world: World, buildingId: number): void
addHelpTask(world: World, personId: number): boolean
refreshBuilding(world: World, building: Building): void
stepSimulation(world: World, random: () => number, baseline?: boolean): StepOutput
summarize(world: World, scenario: string): Result
runBaseline(seed: Seed): Result
```

Functions mutate only their supplied snapshots. A should keep them synchronous and free of imports that perform I/O, wall-clock calls, or global randomness. The scheduled adapter passes `ctx.random`; baseline uses a seed-based RNG. New tasks use `id: 0n` and receive auto-incremented IDs when persisted. Existing task IDs must be preserved. `stepSimulation` returns `{world, events: string[], ended: boolean}`. The adapter persists only changed public rows, the private engine snapshot, events and final result within one reducer transaction.

Private engine data tracks ignition age, touched structures, fractional evacuation throughput, and elapsed ping minutes. Tracking minutes directly preserves the escalation deadline across changes to simulation speed. Dijkstra runs every five ticks and on speed changes. Fire bearings are compass degrees (0 north, 90 east; SVG y increases south). Buildings continue burning for five ticks even if nearby grid fire extinguishes. The run ends at fire extinction, all occupied buildings resolved, or the finite maxTicks guard. Damage includes all touched structures, including buildings still burning at early termination.

The reference engine is an integration implementation. Its default fuel map approximates the supplied hills geometry; A should replace it and tune spread, occupancy, staffing and damage inputs using the actual pipeline. The specified evacuation formula currently yields 155→110 minutes for Building 12. No learned/calibrated accuracy is claimed for these fixtures.

## D's worker registration

1. Connect a Node worker with the generated `DbConnection` and save its token to a private file.
2. Record its `identity.toHexString()` (the identity is public, the token is secret).
3. From the administrator's connection, call `registerWorker({identity: Identity.fromString(hex)})`.
4. Subscribe to public `person`/`building`, classify new text, call `setReplyClass` and `setExplanation` on the registered worker connection.

Registration survives resets. To rotate the worker, register the replacement identity as administrator. Maincloud must be published/seeded with the same account identity used for administrator calls. Numbers shown in the product continue to come from code; the explanation reducer stores text only.

## Verification record

- TypeScript check: passed for module, scripts, tests and generated bindings.
- SpacetimeDB 2.14.1 build and TypeScript binding generation: passed.
- Eight pure simulation/seed tests: passed.
- Initial live integration on a real local instance with four independent SDK clients: passed, including competing claims, claim-owner enforcement, worker restrictions, scheduled escalation/end, baseline, seed rollback and reset.
- A subsequent local hot update timed out; its server stalled while shutting down. Automatic permission review timed out on force-stopping that process. Attempts to verify a separate instance could not establish a connection. Consequently, a final live rerun after the hot update is not verified. Restart/recover the local instance before using it; these runtime failures did not change the public schema or invalidate the successful compile/unit checks.
- Maincloud publishing was intentionally deferred at the user's request.
