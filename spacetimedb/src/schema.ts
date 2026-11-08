import { schema, table, t } from 'spacetimedb/server';

const sim = table({ name: 'sim', public: true }, {
  id: t.u32().primaryKey(),            // always 0
  phase: t.string(),                   // 'prep' | 'fire' | 'ended'
  running: t.bool(),
  tick: t.u32(),
  simMinutes: t.u32(),                 // minutes since fire start
  minutesPerTick: t.u32(),             // speed, default 2
  budgetLeft: t.f64(),                 // prep budget in $
  windDirDeg: t.f64(),                 // direction wind blows TOWARD (Eaton: NE wind → toward SW ≈ 225)
  windMph: t.f64(),
});

const building = table({ name: 'building', public: true }, {
  id: t.u32().primaryKey(),
  name: t.string(),                    // "Building 12"
  kind: t.string(),                    // 'senior' | 'apartments' | 'office' | 'homes' | 'shelter'
  x: t.f64(), y: t.f64(), w: t.f64(), h: t.f64(),   // footprint in the 1000x620 map space
  residents: t.u32(),
  needsHelp: t.u32(),                  // residents who need help moving
  staff: t.u32(),
  vans: t.u32(),
  valueUsd: t.f64(),                   // for damage $
  risk: t.f64(),                       // 0..100 ignition risk from the model (after fixes)
  baseRisk: t.f64(),
  prepared: t.bool(),
  status: t.string(),                  // 'ok' | 'behind' | 'evacuating' | 'clear' | 'burning' | 'lost'
  fireEtaMin: t.f64(),                 // -1 if unknown/unreachable
  evacNeededMin: t.f64(),
  evacStarted: t.bool(),
  peopleOut: t.u32(),
  explanation: t.string(),             // Gemini-written risk note (worker fills it)
});

const person = table({ name: 'person', public: true }, {
  id: t.u32().primaryKey(),
  name: t.string(),
  buildingId: t.u32(),
  floor: t.u8(),
  needsHelp: t.bool(),
  note: t.string(),                    // "wheelchair", "oxygen", "Spanish speaker"
  status: t.string(),                  // 'inside' | 'pinged' | 'safe' | 'cant_move' | 'claimed' | 'out' | 'left_behind'
  pingedAtTick: t.u32(),
  replyText: t.string(),               // free text (worker classifies)
});

const task = table({ name: 'task', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  kind: t.string(),                    // 'help_person' | 'van_run' | 'prep_fix'
  buildingId: t.u32(),
  personId: t.u32(),                   // 0 if none
  priority: t.u8(),                    // 3 = urgent
  claimedBy: t.string(),               // staff name, '' if open
  done: t.bool(),
  createdTick: t.u32(),
});

const fix = table({ name: 'fix', public: true }, {
  id: t.u32().primaryKey(),
  buildingId: t.u32(),
  name: t.string(),                    // "Second evacuation van"
  costUsd: t.f64(),
  riskDrop: t.f64(),                   // from the model
  addVans: t.u32(),                    // e.g. 1 for the van fix
  approved: t.bool(),
});

const fireCell = table({ name: 'fire_cell', public: true }, {
  id: t.u32().primaryKey(),            // y * COLS + x
  x: t.u16(), y: t.u16(),
  fuel: t.f64(),                       // 0 road, ~0.35 lawn/town, 0.6 structure, 1.0 dry brush
  state: t.u8(),                       // 0 unburned, 1 burning, 2 burned
  burnTicks: t.u8(),
});

const eventLog = table({ name: 'event_log', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  tick: t.u32(),
  text: t.string(),
});

const result = table({ name: 'result', public: true }, {
  scenario: t.string().primaryKey(),   // 'with_lantern' | 'without_lantern'
  peopleSafe: t.u32(),
  peopleTotal: t.u32(),
  buildingsLost: t.u32(),
  damageUsd: t.f64(),
  claims: t.u32(),
});

const simTick = table({ name: 'sim_tick' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

// ── Sponsor-track additions (public, reactive) ──
/** Live connections (connect/disconnect lifecycle hooks): the dashboard shows "N devices connected". */
const presence = table({ name: 'presence', public: true }, {
  connectionId: t.string().primaryKey(),   // ConnectionId hex
  identity: t.identity(),
  worker: t.bool(),                        // the registered Gemini worker
  connectedAt: t.timestamp(),
});
/** Static per-building facts the dashboard needs for business impact and data lineage. */
const buildingProfile = table({ name: 'building_profile', public: true }, {
  buildingId: t.u32().primaryKey(),
  reachProbability: t.f64(),               // share of 1,000 simulated Eaton-like fires that reach it
  roof: t.string(), vents: t.string(), eaves: t.string(), windows: t.string(), siding: t.string(),
  yearBuilt: t.u32(),
  sources: t.string(),                     // where each number comes from
});
/** Insurer-ready checklist (California "Safer from Wildfires" measures) per building. */
const mitigation = table({ name: 'mitigation', public: true }, {
  id: t.u32().primaryKey(),                // buildingId * 10 + index
  buildingId: t.u32(),
  measure: t.string(),
  status: t.string(),                      // 'met' | 'missing' | 'unverified'
  fixId: t.u32(),                          // fix that completes it (0 = none)
  note: t.string(),
});

/** Fire engines (units.ts): auto-dispatched to burning buildings, or sent ahead of the fire by Lantern's advisor. */
const unit = table({ name: 'unit', public: true }, {
  id: t.u32().primaryKey(),
  name: t.string(),                        // "Engine 1"
  status: t.string(),                      // 'ready' | 'enroute' | 'onscene' | 'returning'
  targetId: t.u32(),                       // building id (0 = none); kept while returning so clients can draw the way back
  ticksLeft: t.u32(),
  travelTicks: t.u32(),
});

/** The world being played: 0 = the Eaton demo map; otherwise a random scenario number (scenario.ts). */
const scenario = table({ name: 'scenario', public: true }, {
  id: t.u32().primaryKey(),                // always 0
  number: t.u32(),                         // 0 = demo; same number → same world
  label: t.string(),                       // "Eaton demo" / "Scenario #48213" (+ " · fire start picked")
  ignitionX: t.f64(), ignitionY: t.f64(),  // where the fire starts (map units, centre of the ignition cells)
  picked: t.bool(),                        // the fire start was chosen on the map
});

// Private operational state; the public contract above is unchanged.
const admin = table({ name: 'admin' }, {
  id: t.u32().primaryKey(), identity: t.identity(), worker: t.identity().optional(),
});
const worldSeed = table({ name: 'world_seed' }, {
  id: t.u32().primaryKey(), json: t.string(),
});
const engineState = table({ name: 'engine_state' }, {
  id: t.u32().primaryKey(), json: t.string(),
});
const taskOwner = table({ name: 'task_owner' }, {
  taskId: t.u64().primaryKey(), identity: t.identity(),
});
export const db = schema({ sim, building, person, task, fix, fireCell, eventLog, result, simTick,
  presence, buildingProfile, mitigation, unit, scenario,
  admin, worldSeed, engineState, taskOwner });
export default db;
export { simTick };
