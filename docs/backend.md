# Part C backend contract

## State and generated bindings

The eight public tables exactly match section 4 of the build spec: `sim`, `building`, `person`, `task`, `fix`, `fire_cell`, `event_log`, `result`. `sim.id` is always 0. The private `sim_tick` row schedules `tick` once per 1,000,000 microseconds. Initialization creates one schedule, and reset/reseed preserves it. **Initialization also loads A's calibrated seed** (bundled as `spacetimedb/src/seed_data.ts`), so a fresh publish is playable without `npm run seed`. Scheduled reducer calls are private in SpacetimeDB 2.14.1, and `tick` is omitted from client bindings.

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
await connection.reducers.replyCheckin({ personId: 1201, choice: 'cant_move', text: '' }); // Maria R.
// Subscribe before looking up task IDs; they are database-generated, never fixed constants.
const task = [...connection.db.task.iter()].find(t => t.personId === 1201 && !t.done);
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
| `set_speed` / `setSpeed` | `{minutesPerTick: number}` | Integer 1–60. Fire behaviour, ETAs and deadlines are in sim-minutes, so the same fire plays out at any speed. |
| `approve_fix` / `approveFix` | `{fixId: number}` | Prep only; reject duplicates/insufficient budget; apply risk floor 5 and van increase; recompute evacuation/prepared status (prepared = rounded risk < 70 and evacuation beats the fire ETA). |
| `approve_recommended` / `approveRecommended` | `{}` | Prep only; approves the best-value unapproved fixes (expected loss avoided per dollar) that fit the budget. |
| `start_evacuation` / `startEvacuation` | `{buildingId: number}` | Fire only; reject duplicate starts, empty/clear/lost buildings; ping people still inside. |
| `reply_checkin` / `replyCheckin` | `{personId: number, choice: string, text: string}` | Fire only; choices `safe`, `cant_move`, `text`; max 2000 characters. Requires an active check-in. |
| `set_reply_class` / `setReplyClass` | `{personId: number, choice: string}` | Registered worker only; `safe`, `cant_move`, `needs_medical`, `unclear`. Only pending text on a pinged person may be classified. |
| `set_explanation` / `setExplanation` | `{buildingId: number, text: string}` | Registered worker only; max 2000 characters. |
| `claim_task` / `claimTask` | `{taskId: bigint, staffName: string}` | Fire only; reject done/already-claimed tasks; staff name 1–80 characters. Claim and identity ownership commit atomically. |
| `complete_task` / `completeTask` | `{taskId: bigint}` | Fire only; require the claiming identity; reject repeated completion; mark person out and recompute peopleOut from residents. |
| `run_baseline` / `runBaseline` | `{}` | Ended only; the same fire (same `fireSeed`) with no fixes, late evacuation and no check-ins/escalation; idempotent. The tick already writes it when the fire ends. |
| `end_and_compare` / `endAndCompare` | `{}` | Fire only; runs the rest of the fire instantly and writes both results (an "End & compare" button). |
| `reset_sim` / `resetSim` | `{}` | Restore original seed, budget, people, grid and fixes; remove tasks/events/results; preserve worker registration and schedule. |

Dashboard/staff/resident actions are intentionally shared demo controls, as requested; there is no production resident account or building access model. Anyone with access to the demo can reset or start it. Seed replacement and worker registration require the original publishing identity. Staff names are display labels; identity, rather than a matching name, authorizes completion.

Safe replies immediately account for the resident and close obsolete help tasks. Safe replies and rescue completion cannot double-count a person. Repeated `cant_move` replies never create duplicate open help tasks. Classifier `needs_medical` maps to urgent assistance; `unclear` retains the pending check-in and the original escalation deadline. Workers should process each `(personId, replyText)` once and skip anyone no longer pinged. A delayed classification that races a newer free-text reply cannot be version-checked through the fixed two-argument worker reducer, so D should serialize per-person classifications.

## A's seed input

The module ships with A's seed (`seed_data.ts`, generated by `bash data/run_pipeline.sh`). `npm run seed -- <directory>` re-sends a seed through `seed_world` as the administrator: it reads `buildings.json`, `people.json` and `fire_params.json` from the pipeline (default `seed/`), validates them locally with the module's own `parseSeed`, and sends one `seed_world({json})` call. The same validation runs in the reducer, so malformed seeds roll back atomically.

The reducer accepts A's `Seed` (see `spacetimedb/src/sim.ts`):

```ts
{
  buildings: Array<{
    id, name, kind, x, y, w, h, residents, needsHelp, staff, vans, valueUsd, baseRisk,
    referenceFireEtaMin?, explanation?, features?,          // features stay available to D
    fixes: Array<{id, name, costUsd, riskDrop, addVans}>
  }>,
  people: Array<{id, name, buildingId, floor, needsHelp, note}>,
  params: FireParams   // seed/fire_params.json: calibrated constants, 50×31 `fuel` grid, `ignition` cells,
                       // hourly `wind` replay, `fireSeed`, evacuation rates, `prepBudgetUsd`, …
}
```

`spacetimedb/src/seed.ts` checks every numeric parameter's range, that `fuel` has `cols × rows` values in 0–1, that ignition cells have fuel, unique IDs, valid references, footprints inside the map, and that each building's people match `residents` / `needsHelp` exactly. Invalid seeds leave the current world intact. Dynamic fields (statuses, risk after fixes, approved flags, peopleOut, ETAs…) are rebuilt by `buildWorldFromSeed`, never trusted from input. Maria R. is person 1201 (wheelchair) and Robert K. is 1202 (oxygen, never replies).

## A's simulation engine

`spacetimedb/src/sim.ts` is A's engine (pure, synchronous, no I/O, clock or global RNG); `model.ts` re-exports its row types under C's names. The reducers call it like this (details in `spacetimedb/SIM.md`):

```ts
buildWorldFromSeed(seed)                       // rows for every table (seed_world / reset / prep)
startFire(world, p, p.fireSeed)                // set_phase('fire'): ignite, Monte Carlo ETAs
stepSimulation(world, p, p.fireSeed)           // tick → StepResult { sim, cells, buildings, people,
                                               //   tasksUpdated, tasksNew (id 0n), events, ended }
applyFix / recommendFixes / startEvacuation / applyReply / refreshDerived
computeResults(world, p, 'with_lantern') · runBaseline(seed) · fastForward(world, p, p.fireSeed)
```

Randomness comes from `fireSeed`, keyed to the absolute fire step (not `ctx.random`), so the live run and the "without Lantern" baseline burn **the same fire** at any speed and rehearsals are repeatable. The tick persists only the rows the engine reports as changed. The private `engine_state` row now stores the exact sim-minute each resident was pinged, so escalation deadlines and evacuation progress stay exact when the speed changes. Fire bearings are compass degrees toward which the wind blows (0 north, 90 east; SVG y increases south). The run ends when the fire is out or after `maxSimMinutes`. Simulated on-site staff take open help tasks after a 15-tick window for human staff — immediately if the fire is ≤ 30 minutes from the building. Calibration and data sources: `data/README.md`.

## D's worker registration

1. Connect a Node worker with the generated `DbConnection` and save its token to a private file.
2. Record its `identity.toHexString()` (the identity is public, the token is secret).
3. From the administrator's connection, call `registerWorker({identity: Identity.fromString(hex)})`.
4. Subscribe to public `person`/`building`, classify new text, call `setReplyClass` and `setExplanation` on the registered worker connection.

Registration survives resets. To rotate the worker, register the replacement identity as administrator. Maincloud must be published/seeded with the same account identity used for administrator calls. Numbers shown in the product continue to come from code; the explanation reducer stores text only.

## Verification record

Integration with A's engine (merge of `backend_part` into `main`): type-check passes; 20 engine/preview tests pass;
`spacetime build` passes; on a fresh local 2.14.1 server `init` seeds A's data, `npm run smoke` passes (authorization,
seed rollback, competing claims, rescue ownership, worker writes, scheduled escalation/end, baseline, reset), the
scheduled tick holds 1 tick/s, and server results equal the bare engine's for the same actions (with and without
fixes/evacuations). Earlier record from Part C:

- TypeScript check: passed for module, scripts, tests and generated bindings.
- SpacetimeDB 2.14.1 build and TypeScript binding generation: passed.
- Eight pure simulation/seed tests: passed.
- Initial live integration on a real local instance with four independent SDK clients: passed, including competing claims, claim-owner enforcement, worker restrictions, scheduled escalation/end, baseline, seed rollback and reset.
- A subsequent local hot update timed out; its server stalled while shutting down. Automatic permission review timed out on force-stopping that process. Attempts to verify a separate instance could not establish a connection. Consequently, a final live rerun after the hot update is not verified. Restart/recover the local instance before using it; these runtime failures did not change the public schema or invalidate the successful compile/unit checks.
- Maincloud publishing was intentionally deferred at the user's request.
