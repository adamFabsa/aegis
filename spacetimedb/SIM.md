# Simulation engine — how the module uses it, and what the fields mean (for B)

`spacetimedb/src/sim.ts` is the whole simulation as **pure functions** (no `ctx`, no `Date`, no
`Math.random`, no I/O). `spacetimedb/src/seed_data.ts` is generated from `seed/*.json` and exports `SEED`
(buildings, people, fire params); the module's `init` loads it, so a fresh publish is playable.
Tests: `npm test` (engine + preview, 20 tests).

**The live module is [`spacetimedb/src/index.ts`](src/index.ts)** (Part C's reducers, auth and claim ownership,
driving this engine) — its contract for B and D is [`docs/backend.md`](../docs/backend.md). The recipes below
are what it does, kept here as the engine's integration guide. `preview/index.html` runs the same engine in a
browser (see `preview/README.md`).

The row interfaces in `sim.ts` (`SimRow`, `BuildingRow`, `PersonRow`, `TaskRow`, `FixRow`, `FireCellRow`,
`ResultRow`) match the tables in LANTERN_SPEC §4 field-for-field. **Rows from `ctx.db` are readonly —
spread-copy them before passing them in.** `task.id` is `bigint`; the sim creates tasks with `id: 0n`.

## Reducer recipes (C)

Accessor names below assume the spec's schema (`ctx.db.building`, `ctx.db.fireCell`, …) — adjust to yours.

```ts
import * as S from './sim';
import { SEED } from './seed_data';
const P = SEED.params;

function loadWorld(ctx): S.World {
  return {
    sim: { ...ctx.db.sim.id.find(0)! },
    buildings: [...ctx.db.building.iter()].map((r) => ({ ...r })),
    people: [...ctx.db.person.iter()].map((r) => ({ ...r })),
    tasks: [...ctx.db.task.iter()].map((r) => ({ ...r })),
    cells: [...ctx.db.fireCell.iter()].map((r) => ({ ...r })),
  };
}
function save(ctx, r: S.StepResult) {
  ctx.db.sim.id.update(r.sim);
  for (const c of r.cells) ctx.db.fireCell.id.update(c);
  for (const b of r.buildings) ctx.db.building.id.update(b);
  for (const p of r.people) ctx.db.person.id.update(p);
  for (const t of r.tasksUpdated) ctx.db.task.id.update(t);
  for (const t of r.tasksNew) ctx.db.task.insert({ ...t, id: 0n });
  for (const text of r.events) ctx.db.eventLog.insert({ id: 0n, tick: r.sim.tick, text });
}
```

| Reducer | Call |
|---|---|
| `seed_world` / `reset_sim` | `const w = S.buildWorldFromSeed(SEED)` → clear tables, insert `w.sim`, `w.buildings`, `w.people`, `w.cells`, `w.fixes` (tasks/results/event_log empty). |
| `set_phase('fire')` | `const w = loadWorld(ctx); save(ctx, S.startFire(w, P, P.fireSeed))` — resets the grid, lights the ignition cells, computes ETAs, `running = true`. |
| `set_phase('prep')` | Simplest: `reset_sim`, then re-approve the fixes that were approved (`S.applyFix` for each). |
| `set_speed(m)` | `sim.minutesPerTick = m` (1–10). Fire behaviour is per sim-minute, so speed never changes the fire. |
| `approve_fix(fixId)` | `const r = S.applyFix(sim, building, fix, people, P)`; `if (r.error) throw new SenderError(r.error)`; update sim, building, fix; log `r.event`. |
| `start_evacuation(id)` | `const r = S.startEvacuation(w, id, P)`; error → SenderError; update `r.building`, `r.people`; log `r.events`. |
| `reply_checkin(pid, choice, text)` | free text → just store `replyText` (worker classifies). Otherwise `const r = S.applyReply(w, pid, choice)`; update `r.person`, `r.tasksUpdated`; insert `r.task` if present (`id: 0n`). |
| `set_reply_class(pid, choice)` | Same as above; choice ∈ `safe` \| `cant_move` \| `needs_medical` \| `unclear` (unclear = no change, escalates normally). |
| `claim_task(id, name)` | Yours (atomic): throw `SenderError('already claimed')` if `claimedBy !== ''`; set `claimedBy`; person → `claimed`. |
| `complete_task(id)` | Yours: `done = true`; person → `out`. (The tick recomputes `peopleOut` anyway.) |
| `tick` (scheduled, 1 s) | `export const tick = spacetimedb.reducer({ onSchedule: simTick }, { timer: simTick.rowType }, (ctx) => { … })` (2.14 syntax). Return early unless `phase === 'fire' && running`; then `const w = loadWorld(ctx); const r = S.stepSimulation(w, P, P.fireSeed); save(ctx, r);` if `r.ended`: upsert `S.computeResults(w, P, 'with_lantern')` and `S.runBaseline(SEED)`. Schedule it in `init`: `ctx.db.simTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) })`. |
| `run_baseline` | `S.runBaseline(SEED)` → upsert result `'without_lantern'`. Same fire seed ⇒ the end screen compares **the same fire**. |
| optional "End & compare" | `S.fastForward(w, P, P.fireSeed)` then save everything + results. |
| optional "Approve recommended" | `S.recommendFixes(w, fixes, P)` → fix ids to approve in order (fits the budget). |

Notes
- Use `P.fireSeed` (a number) as the RNG source, not `ctx.random()`: fire randomness is keyed to the
  absolute fire step, so the live run and the baseline burn **the same fire at any speed** (tested at 1, 2,
  5, 10 min/tick and with a mid-fire speed change), and rehearsals are repeatable.
- A tick costs ~0.9 ms inside SpacetimeDB (2–12 ms cold in Node). It writes ~50–200 changed cells.
- Exports are camelCase (`claimTask`) but reducer names on the wire / CLI are snake_case (`claim_task`).
  The entry file may only export SpacetimeDB values — import `sim.ts`, don't re-export it.
- `pingedAtTick` is a tick; elapsed minutes are `(tick − pingedAtTick) × minutesPerTick`, so changing speed
  mid-evacuation slightly re-times progress. Fine for the demo.

## What the fields mean (B)

**building.status** — `ok` · `behind` (evacuation needs longer than the fire ETA) · `evacuating` · `clear`
(everyone out) · `burning` · `lost`. In prep everything is `ok`; show `risk` / `prepared` instead.

**building.fireEtaMin** — minutes until fire touches the building. Prep: "if a fire like Eaton reaches
it" (median of 400 simulated fires). Fire phase: live Monte Carlo median, smoothed. **−1 = not expected
to reach.** `0` when burning/lost. Show with `S.fmtMin()` → `1h50m`.

**building.risk** (0–100) — chance the building is destroyed *if* the fire reaches it, from the CAL FIRE
DINS model. Show it rounded. Bands on the rounded value: High ≥ 70, Elevated 40–69, Low < 40. **prepared** =
rounded risk < `preparedRiskMax` (70) **and** evacuation beats the fire ETA → "Prepared · better insurance rating".

**fix.riskDrop** — from the DINS model (vents, roof) or from the fire simulation ("Clear brush to 30 ft":
defensible space isn't recorded in DINS — label it "simulated"). Vans: 0 risk, `addVans = 1`.

**person.status** — `inside` → `pinged` (no reply yet) → `safe` / `cant_move` → `claimed` → `out`;
`left_behind` if the building is lost first. Unaccounted = `pinged`/`cant_move`/`left_behind` in evacuating
buildings (`S.counters(world)` gives header numbers). Maria R. = 1201, Robert K. = 1202 (never replies).

**task** — `help_person` tasks come from "I can't get out" (priority 3) or escalation after 10 sim-minutes of
silence (priority 1–3 by need + fire distance). Humans get a 15-tick window to claim; then simulated
on-site staff take it: their `claimedBy` ends with `' · on-site'` (e.g. `Priya · on-site`). Human staff
names for the phone: `S.PHONE_STAFF` (`Alex`, `Sam`, `Jordan`, `Taylor`); roster in `seed/staff.json`.
Show open tasks = `!done`, sorted by `priority` desc then `createdTick`. Client SDK: `u64` ids and
`table.count()` are **bigint** (wrap with `Number()`); reducer calls return a Promise that rejects with the
`SenderError` text (e.g. `already claimed by Alex`) — show it as a toast.

**fire_cell** — `state` 0/1/2; `burnTicks` = steps burning (vegetation burns 12 steps, buildings 19) — use
it for flame intensity / fade. `fuel`: 0 road, 0.1 shelter lot, 0.35 lawn/town, 0.6 building, 1.0 dry brush.

**sim.windDirDeg** — direction the wind blows **toward**, compass degrees, map-up = north (225 = toward
bottom-left). Replays the real Burbank winds from the Eaton ignition hour by hour; `S.compass()` → `SW`.

**event_log** — short human lines ("Escalated 8 in Building 12 — no reply: Robert K. (oxygen), …",
"Maria R. reached Shelter A with Alex", "Building 12 clear — everyone is out", "Hillside homes lost — …").

Map geometry (roads, hills path, ignition cells) is in `data/neighborhood.json`; the map scale is
6 m per unit (the 1000-unit map ≈ 6 km), which is what makes the fire move at the Eaton Fire's real speed.
