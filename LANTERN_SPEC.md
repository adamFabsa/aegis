# Lantern — Build Spec (HackUTD 2026: Zero Day)

> Hand this whole file to Claude (or any coding assistant) as the project brief.
> Hacking started Sat Nov 7, 12:00 PM. **Devpost draft due Sat 11:00 PM. Final submission Sun 12:00 PM sharp. Judging Sun 1–4 PM.**

---

## 1. What we are building (one paragraph)

**Lantern** is a wildfire preparedness and evacuation platform for property managers, shown as a live, playable simulation. A drawn (simulated) neighborhood of apartment towers, senior-living buildings, homes, an office and a shelter sits next to dry-brush hills. **Prep phase:** the manager sees each building's fire risk (learned from Cal Fire's real damage records), spends a limited budget on fixes (second evacuation van, brush clearing, ember vents, roof), and buildings that are prepared earn a better insurance rating. **Fire phase:** a fire calibrated to the real 2025 Eaton Fire (NASA satellite detections + real wind) spreads across the hills toward town. Every building shows *fire arrives in X* vs *evacuation needs Y*. The manager taps **Start evacuation**; residents get a check-in ("I'm safe" / "I can't get out"); anyone who can't move or stays silent is escalated to staff, who **claim** them (only one person can claim each resident). **End screen:** our run vs. the same fire with no prep and no Lantern — people safe, buildings lost, damage, insurance claims.

**Pitch line:** "The best claim is the one that never happens — and the best evacuation is the one you planned before the fire."

**Who the customer is:** property managers responsible for buildings full of people (senior living, apartments, offices). Users: portfolio manager (dashboard), building staff (phone), residents (check-in), insurer (rewards prepared buildings).

---

## 2. Tracks we are entering and exactly how we satisfy each

### Sponsor tracks (3)

**State Farm — "The Worst Day, at Scale: Intelligent Catastrophe Response."**
Brief: *When a major disaster affects thousands of people simultaneously, how might we use AI and technology to identify those with the most urgent needs, coordinate assistance, and ensure no one is overlooked?*
State Farm feedback at their booth: value people above property; insurers win by preventing losses (fewer/smaller claims); prepared customers deserve a more attractive policy; prepare before the disaster; mitigate risk so the loss never happens.
- Identify urgent needs → rank people by (fire ETA to their building) × (needs help moving / no reply).
- Coordinate assistance → staff claim tasks; claims are locked so no double-dispatch.
- No one overlooked → silent residents auto-escalate; counter of "unaccounted" people.
- Prevention / better policy → Prep phase fixes lower risk; "Prepared · better insurance rating" badge.
- Fewer, smaller claims → end screen compares claims with vs without Lantern.

**CBRE.**
Brief: *Build an application that connects fragmented real estate data to predict operational failures, quantify business impact, or execute solutions before disruptions spread!*
CBRE feedback at their booth: use a large dataset; have a dashboard; define who the customer is; show what a user does when a disaster comes (e.g., a fire is coming and I need to evacuate people) — how a user uses the platform.
- Connect fragmented data → each building combines construction features, occupancy, staff/vans, hazard zone; risk model trained on Cal Fire DINS (large statewide dataset).
- Predict operational failures → "evacuation needs 3h, fire arrives in 1h50m" = predicted evacuation failure; building ignition risk.
- Quantify impact → dollars at risk per building, people at risk, damage totals.
- Execute before spread → fixes in Prep; Start evacuation + staff tasks in Fire; unprepared burning buildings spread fire to neighbors.
- Customer + workflow → property-manager dashboard + staff phone + resident check-in (see §8 demo).

**Spacetime — Main track ("Build your project on Spacetime").**
Rule: *Spacetime must power the app's primary functionality — not just chat or player movement.* **Public GitHub source required to win.**
- The simulation itself runs inside Spacetime (scheduled reducer ticks the fire, evacuation, escalation).
- All state (buildings, people, tasks, fire cells, results) lives in Spacetime tables; the dashboard, phone panel and real phones subscribe live.
- Claims are reducers → atomic, no double claims.
- The AI worker is just another client writing to the same live state.
- (Optional side quest: Spacetime's separate **ScrabbleBot tournament**, live Sat 10:45 PM, TypeScript starter at scrabblebot.spacetimedb.com — only if someone has spare time; confirm with organizers whether it counts toward our track limit.)

### MLH prizes (do not count toward the sponsor limit)

| Prize | How we qualify | Owner |
|---|---|---|
| Best Use of Gemini API | Gemini classifies free-text resident replies and writes the plain-English "why this building is at risk / what to fix" note. Numbers always come from code. | D |
| Best Use of Tiger Data | FIRMS fire detections stored as a time-series hypertable (spread-rate queries with `time_bucket`) + the DINS dataset used to train the risk model. | A |
| Best Use of Vultr | Host the built website and the Node AI worker on a Vultr instance. | D |
| Best Domain from GoDaddy Registry | Register our domain via mlh.link/godaddyregistry, code **MLHUTD84**. | D |
| SpaceXSI (Cursor + Grok bot) | Only if we build with Cursor + their Grok bot — check mlh.link/spacexsi. | All |
| DEV writing challenge ($100) | Publish the build story on dev.to after the event. | D |
| HackUTD Design track | Polished drawn simulator. | B |

Skip: MongoDB (would be a third database), Solana (no fit). Ask the help desk what the Virality track requires.

### Hackathon rules we must follow (MLH)
- No code written before the event and **no reuse of code from previous projects** (including our old Winter Uri project). Ideas and knowledge are fine; code must be new.
- Public frameworks/libraries are allowed but **must be listed in the README**.
- Repo is public; first commit is after Sat 12:00 PM.
- Label simulated numbers as simulated (on screen and on Devpost). The neighborhood is fictional; fire behavior is calibrated to the real Eaton Fire; building risk is learned from real Cal Fire data.

---

## 3. Architecture

```
┌──────────────────────────┐        live subscriptions        ┌─────────────────────────┐
│  React website (Vite)    │ ◀──────────────────────────────▶ │  SpacetimeDB module     │
│  - Simulator page        │        reducer calls             │  (TypeScript)           │
│  - /phone page           │                                  │  tables + reducers      │
│  - End screen            │                                  │  scheduled sim tick     │
└──────────────────────────┘                                  └───────────▲─────────────┘
                                                                          │ client (same bindings)
                                                              ┌───────────┴─────────────┐
                                                              │ Node AI worker          │
                                                              │ Gemini: reply triage,   │
                                                              │ risk explanations       │
                                                              └─────────────────────────┘
┌──────────────────────────────────────────────┐
│ Offline data pipeline (Python + Tiger Data)  │ → produces seed/buildings.json (risk, fix effects)
│ FIRMS + wind → fire calibration constants    │ → produces seed/fire_params.json
│ Cal Fire DINS → risk model                   │
└──────────────────────────────────────────────┘
```

### Tech stack
- **SpacetimeDB 2.14.x** (npm `spacetimedb@2.14.1`), TypeScript server module, Maincloud hosting. Free tier covers the weekend; redeem code **HACKUTD2026** at spacetimedb.com/redeem for extra credit.
- **Website:** React + TypeScript + Vite from `spacetime dev --template react-ts`. Plain CSS or Tailwind. SVG for the town.
- **Worker:** Node 22+ TypeScript, same generated bindings, `@google/genai` for Gemini (use a current Gemini Flash model).
- **Data:** Python 3, pandas, scikit-learn, psycopg; Tiger Data (managed Postgres/Timescale).
- **Hosting:** Vultr (static site + worker), domain via GoDaddy Registry.

### Repo layout
```
lantern/
  README.md                 # what it is, how to run, ALL frameworks/libraries used, "built this weekend"
  spacetimedb/              # server module
    src/index.ts            # tables + reducers
    src/sim.ts              # PURE simulation step functions (shared by tick + baseline)
  web/                      # React app (from template)
    src/module_bindings/    # generated — commit it
    src/components/...
  worker/                   # Node Gemini worker
  data/                     # Python pipeline + notebooks
  seed/
    buildings.json
    people.json
    fire_params.json
  spacetime.json            # commit it
```

---

## 4. SpacetimeDB module

### Setup commands
```bash
curl -sSf https://install.spacetimedb.com | sh
spacetime login
spacetime dev --template react-ts          # local server + publish + bindings + Vite
spacetime publish lantern --yes            # to Maincloud
spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb
spacetime logs lantern -f
spacetime sql lantern "SELECT * FROM building"
```

### Gotchas (read before writing code)
- Reducers return nothing; throw `SenderError` to reject/roll back.
- Reducers **cannot** do network or file I/O, `async/await`, `Date`, or `Math.random`. Use `ctx.timestamp` and `ctx.random()` (deterministic).
- Lifecycle hooks only run if written as `export const init = spacetimedb.init(...)`.
- Table names snake_case; `schema({...})` takes one object; default-export the schema; pass `0n` for autoInc ids.
- `iter()`/`filter()` return iterators → spread into arrays.
- Private tables are invisible to clients (including the worker) — make game tables `public: true`.
- `u64` columns arrive in React as `bigint` → wrap with `Number()` before rendering.
- Rows from `useTable` are readonly — copy before sorting.

### Tables (contract between A and B — do not rename after 4:30 PM without telling B)

```ts
import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

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

const spacetimedb = schema({ sim, building, person, task, fix, fireCell, eventLog, result, simTick });
export default spacetimedb;
```

### Reducers

| Reducer | Who calls it | Behavior |
|---|---|---|
| `seed_world(json)` | admin script | Wipes tables, loads `seed/*.json` (buildings, people, fixes, fire grid fuel, params). Sets phase `prep`. |
| `set_phase(phase)` | dashboard | `prep` → reset fire grid; `fire` → ignite starting cells, `running=true`. |
| `set_speed(minutesPerTick)` | dashboard | Change sim speed. |
| `approve_fix(fixId)` | dashboard (Prep) | Check budget; mark approved; subtract cost; building.risk -= riskDrop (floor 5); vans += addVans; recompute evacNeeded; `prepared = risk < 40 && evacNeeded < referenceFireEta`; log event. |
| `start_evacuation(buildingId)` | dashboard (Fire) | evacStarted=true, status `evacuating`; every person in the building → `pinged` with pingedAtTick; log. |
| `reply_checkin(personId, choice, text)` | resident phone | choice `safe` → status `safe`; `cant_move` → `cant_move` + create urgent `help_person` task; `text` (free text) → store `replyText`, worker classifies it. |
| `set_reply_class(personId, choice)` | worker only | Same as above from Gemini's classification. Check caller is the worker identity. |
| `claim_task(taskId, staffName)` | staff phone | Throw `SenderError('already claimed')` if `claimedBy != ''`. Else set it; person → `claimed`. |
| `complete_task(taskId)` | staff phone | done=true; person → `out`; building.peopleOut++. |
| `set_explanation(buildingId, text)` | worker only | Stores Gemini text. |
| `run_baseline()` | dashboard (end) | Runs the whole fire instantly using `sim.ts` on a copy of the seed with **no fixes, no evacuation until fire is 10 sim-minutes away, no escalation, no claims** → writes `result['without_lantern']`. |
| `reset_sim()` | dashboard | Re-seed from stored seed. |
| `tick` (scheduled, every 1s) | scheduler | If `running`, call `stepSimulation` (below). When fire is out or all buildings resolved → phase `ended`, write `result['with_lantern']`. |

`init`: insert `sim` row 0 and the `sim_tick` schedule: `ScheduleAt.interval(1_000_000n)` (1 second, microseconds).

### Simulation rules (`spacetimedb/src/sim.ts` — pure functions, no ctx, so the tick and the baseline share them)

**Grid:** 50 × 31 cells over the 1000 × 620 map (each cell 20 × 20 units). Fuel from the seed: hills polygon = 1.0, lawns/town = 0.35, building footprints = 0.6, roads = 0.0, shelter lot = 0.1.

**Fire spread per tick** (use a seeded RNG passed in: `ctx.random()` in the reducer, a seeded PRNG in the baseline):
- A burning cell stays burning for `BURN_TICKS = 3`, then becomes burned (2).
- For each burning cell, each of 8 neighbors with state 0 ignites with probability
  `p = BASE_SPREAD × fuel × windFactor`, where
  `windFactor = max(0.15, 1 + WIND_K × cos(angle between neighbor direction and wind direction))`.
- **Ember spotting:** with probability `SPOT_P × (windMph / 40)` a burning brush cell ignites a random cell 2–4 cells downwind (Eaton spread fast through embers).
- Constants come from `seed/fire_params.json` (A calibrates them from FIRMS + wind so the front moves at a speed proportional to the real Eaton Fire's first hours). Starting defaults: `BASE_SPREAD = 0.30`, `WIND_K = 1.4`, `SPOT_P = 0.02`, ignition cells in the top-right corner of the hills.

**Fire ETA per building:** every 5 ticks run Dijkstra from all burning cells over cells with fuel > 0, edge cost = `1 / (BASE_SPREAD × fuel × windFactor)` ticks; ETA = min cost to any cell in the footprint × minutesPerTick. Unreachable → −1.

**Evacuation time per building (minutes):**
`evacNeeded = 20 + 60 × needsHelpRemaining / (STAFF_RATE × staff + VAN_RATE × vans)` with `STAFF_RATE = 0.5`, `VAN_RATE = 2` people/hour. Tune so Building 12 (9 needing help, 4 staff, 1 van) ≈ 3h and with a second van ≈ 1h35m.

**Status per building:** `behind` if evac not done and `evacNeeded > fireEta`; `evacuating` if started; `clear` when everyone is out; `burning` / `lost` from ignition.

**Evacuation progress per tick (started buildings):** mobile residents who replied `safe` or are still `pinged` move `out` at a steady rate; people with `needsHelp` only move `out` via a completed `help_person` task. In the baseline, needs-help people are moved at the raw staff rate with no tasks.

**Escalation:** a `pinged` person with no reply after `ESCALATE_MIN = 10` sim-minutes → urgent `help_person` task + log "Escalated: Maria R. (no reply)".

**Building ignition:** when a burning cell overlaps a building footprint, each tick the building ignites with probability `risk / 100 × 0.5`. Ignited → `burning` for 5 ticks → `lost`. Anyone not `out` when it is lost → `left_behind`. A burning building sets its footprint cells burning (spread to neighbors).

**Results:** people safe = `out` + `safe` who were evacuated; buildings lost; damage = Σ valueUsd × (lost ? 1 : burning-touched ? 0.3 : 0); claims = number of buildings/homes with damage.

---

## 5. Seed data (`seed/`)

`buildings.json` — positions match the mockup's 1000 × 620 map:

| id | name | kind | x | y | w | h | residents | needsHelp | staff | vans | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 12 | Building 12 | senior | 570 | 250 | 150 | 70 | 38 | 9 | 4 | 1 | closest senior building to the fire |
| 9 | Building 9 | senior | 780 | 300 | 110 | 60 | 22 | 6 | 3 | 1 | |
| 7 | Building 7 | apartments | 420 | 290 | 120 | 90 | 64 | 3 | 2 | 0 | |
| 3 | Building 3 | apartments | 170 | 270 | 140 | 80 | 80 | 4 | 2 | 0 | |
| 15 | Building 15 | office | 140 | 480 | 130 | 64 | 12 | 0 | 1 | 0 | |
| 10 | Building 10 | apartments | 800 | 470 | 130 | 70 | 30 | 2 | 1 | 0 | |
| 20 | Hillside homes | homes | 430 | 150 | 280 | 40 | 14 | 2 | 0 | 0 | row of 5 houses |
| 99 | Shelter A | shelter | 440 | 505 | 140 | 60 | 0 | 0 | 2 | 0 | destination |

Each building also gets model features (A fills from the risk model): roof type, vent screens, eaves, siding, brush distance (ft), year built → `baseRisk`. Values ($) are placeholders, labeled simulated.

`fixes` (per building, A computes `riskDrop` from the model): Second evacuation van ($48K, addVans 1), Clear brush to 30 ft ($12K), Ember-resistant vent screens ($9K), Class A roof ($140K). Prep budget $500K.

`people.json`: generate names + floors; include **Maria R. — Building 12, floor 3, wheelchair** (demo hero) and **Robert K. — Building 12, floor 2, oxygen** (stays silent → escalates).

Map geometry (roads, hills polygon, trees, parking) — copy from the design mockup `Main.dc.html` SVG: hills path `M560,0 L1000,0 L1000,285 C930,255 880,218 820,206 C760,196 700,152 640,122 C608,102 584,62 560,0 Z`; roads: horizontal y 430–466 (full width), vertical x 360–392 (full height), secondary horizontal y 214–236 from x 392 to 1000.

---

## 6. Data pipeline (Person A; Gemini worker = Person D)

### Sources (all free/public)
1. **NASA FIRMS active-fire detections** — firms.modaps.eosdis.nasa.gov (free MAP_KEY). Area API, e.g.
   `https://firms.modaps.eosdis.nasa.gov/api/area/csv/MAP_KEY/VIIRS_SNPP_SP/-118.25,34.10,-117.95,34.30/2/2025-01-07` (west,south,east,north / days / start date — check source names on the API page). Use Jan 7–8, 2025 (Eaton Fire).
2. **Fire perimeters** — NIFC open data "WFIGS Interagency Fire Perimeters" (Eaton, Palisades) for the final burned shape.
3. **Wind** — Iowa Environmental Mesonet ASOS (no signup), Burbank (BUR) or El Monte (EMT), Jan 7–9 2025:
   `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=BUR&data=sknt&data=drct&data=gust&year1=2025&month1=1&day1=7&year2=2025&month2=1&day2=9&tz=America/Los_Angeles&format=onlycomma`
4. **Cal Fire Damage Inspection (DINS)** — data.gov "CAL FIRE Damage Inspection (DINS) Data" (statewide, many fires) + "Eaton Fire Structure Status" / "Palisades Fire Structure Status". Inspect the columns; DINS typically records damage level plus construction features such as roof construction, eaves, vent screens, exterior siding, window panes, decks, fences attached, year built.
5. Reference visual: NASA SVS "Spread of the Palisades and Eaton Fires" (svs.gsfc.nasa.gov/5558). Optional: Cal Fire Fire Hazard Severity Zones layer.

### Steps
1. **Tiger Data:** create a service; table `firms_detection(time timestamptz, lat, lon, frp, confidence)` as a **hypertable**; load FIRMS CSV. Query spread with `time_bucket('1 hour', time)` → max distance from the first detection per hour → front speed (km/h) and bearing. Load DINS into a normal table `dins_structure`.
2. **Calibrate:** map the real front speed and wind into `BASE_SPREAD`, `WIND_K`, `SPOT_P` so our grid front crosses the hills toward Building 12 in about the same *relative* time; write `seed/fire_params.json` (+ wind dir/speed per hour for the replay).
3. **Risk model:** target = destroyed (vs. not), features = construction fields above + year built. Logistic regression (explainable) — or gradient boosting with SHAP if time. Report one honest stat for the pitch, e.g. "In Cal Fire's records, buildings with X were destroyed Y% of the time vs Z%." Compute `riskDrop` for each fix as the change in predicted risk when that feature is improved.
4. **Write `seed/buildings.json`** with features, `baseRisk`, and per-building fixes.
5. **Gemini worker (Node):**
   - Subscribe to `person` rows; when `replyText` is new, ask Gemini to classify into `safe` / `cant_move` / `needs_medical` / `unclear`; call `set_reply_class`. Unclear → leave for a human (escalates normally).
   - For each building, generate a 2-sentence explanation from its features + model contributions; call `set_explanation`.
   - Register the worker's identity as `worker` (store its token in a file so the identity stays stable).
   - Never let Gemini produce numbers shown in the UI.

---

## 7. Website (Person B)

Design reference: the "Lantern app screens" design canvas (dark navy UI, amber accent `#F2A93B`, red `#FF5A4E`, green `#3DD68C`, background `#0B0F17`, panels `#121826`, borders `#232B3B`, fonts Inter + Space Grotesk). Keep the dashboard **simple**.

### Simulator page (`/`)
- **Header:** Lantern logo + "Eaton Fire replay · simulated neighborhood"; Prep/Fire toggle (`set_phase`); clock (from `simMinutes`); speed; 3 counters: People safe (x/140), Unaccounted, Buildings at risk.
- **Town (main area, SVG 1000 × 620 viewBox, aspect-ratio kept):**
  - Base layer: ground, dry-brush hills, roads with dashed lines, trees, parking, buildings drawn as roof + front face with lit windows, homes row, green Shelter A (copy from mockup).
  - Fire layer from `fire_cell`: burned cells = charred dark with ember dots; burning cells = animated flame sprites (gradient flame shapes, flicker via SMIL or CSS); glow + drifting smoke plumes toward the wind direction.
  - Evacuation layer: dashed green route from each evacuating building to Shelter A; animated people dots and van moving along it (`out` count drives how many).
  - Status tags over each building from `building.status` / `risk` (Prep: "Risk 82" / "Prepared"; Fire: "Behind" / "Evacuating" / "Clear" / "Burning").
  - Wind chip (direction + mph).
  - Click a building → selects it for the side card.
- **Side card (selected building):**
  - Prep: risk score, Gemini explanation, fixes with cost + risk drop + **Approve**; budget left; "Prepared · better insurance rating" badge.
  - Fire: "Fire arrives in" vs "Evacuation needs", **Start evacuation**, progress (x of y out), unaccounted names.
- **Phone panel** (drawn phone frame) with tabs **Resident** / **Staff**:
  - Resident: pick a resident (dropdown); Lantern message bubble; buttons "I'm safe" / "I can't get out" + a free-text box (goes to Gemini); reply bubble + Lantern follow-up ("Help is on the way, Alex is coming to floor 3").
  - Staff: pick a staff member; list of open tasks sorted by priority; **Claim** / **Done**; claimed tasks show "Claimed by Alex".
- **Live feed** (one line, latest events from `event_log`).

### `/phone?role=resident&id=…` and `/phone?role=staff&name=…`
Same components as the phone panel, full-screen, so judges can play on their own phones (QR code on the dashboard). This is the Spacetime "multiplayer" moment.

### End screen (`/results` or overlay when `phase = ended`)
Two columns from `result`: **With Lantern** vs **Without Lantern** — people safe, buildings lost, damage, insurance claims. Line: "The best claim is the one that never happens." Small note: "Simulated neighborhood; fire calibrated to the real Eaton Fire."

---

## 8. Demo script (2 minutes)

1. "In the Eaton Fire, all 17 people who died were in the area where evacuation orders arrived hours late, and residents were left behind at senior facilities. Lantern is built so that never happens."
2. **Prep:** click Building 12 → risk 82, evacuation would take 3h. Approve "Second evacuation van" + "Clear brush" → evac 1h35m, badge "Prepared · better insurance rating" (State Farm: prevention, better policy; CBRE: act before disruption).
3. **Fire:** toggle Fire → flames spread from the hills with the real Eaton wind. Building 9 turns "Behind".
4. **Start evacuation** on Building 12 → people and van move to Shelter A.
5. **Resident phone (or a judge's real phone):** Maria taps "I can't get out" → she jumps to the top of staff tasks. Robert stays silent → auto-escalates after 10 sim-minutes.
6. **Staff phone:** two people try to claim Maria at once — only one gets it; every screen updates instantly (Spacetime).
7. **End screen:** with vs without Lantern. "The best claim is the one that never happens."

Per-sponsor 30-second pitches: State Farm (people first, prevention, better policy, no one overlooked); CBRE (large real dataset, customer = property manager, predict → quantify → act, the fire-evacuation workflow); Spacetime (the simulation runs inside Spacetime, every screen in sync, atomic claims, AI worker as a peer client).

---

## 9. Team split

**A — simulation engine + data/model (heavy)**
- [ ] `spacetimedb/src/sim.ts` pure step functions: fire spread (wind, embers), fire ETA (Dijkstra), evacuation progress, escalation, building ignition, results. Unit-test them in plain Node before wiring in.
- [ ] `run_baseline` logic (the "without Lantern" run) using the same `sim.ts`.
- [ ] Data: FIRMS key + downloads, Tiger Data hypertable + spread-rate query, wind data → `seed/fire_params.json`.
- [ ] DINS → risk model → `seed/buildings.json` (features, baseRisk, fixes with riskDrop) + one honest real-data stat for the pitch.
- [ ] Tune constants so the demo plays well (Building 12: ~3h evac → ~1h35m with second van; fire reaches the town in ~3–4 real minutes at default speed).
- Done when: `sim.ts` passes its tests, seed files exist, and the fire looks right in the browser.

**B — website + visuals (heavy)**
- [ ] Town SVG from the mockup as components; fire/smoke/evac layers driven by live tables.
- [ ] Header, side card (Prep + Fire), phone panel, live feed, end screen.
- [ ] `/phone` pages + QR code.
- [ ] Polish for the Design track; works at laptop and phone widths.
- Done when: every number and color on screen comes from Spacetime, nothing hard-coded.

**C — Spacetime backend, part 1 (tables + game actions)**
- [ ] Project setup (`spacetime dev --template react-ts`), publish to Maincloud, generate bindings — **schema + bindings published by 4:30 PM** (tables in §4 exactly) so B and A can start.
- [ ] Reducers: `seed_world`, `set_phase`, `set_speed`, `approve_fix`, `start_evacuation`, `reply_checkin`, `claim_task` (atomic, rejects double claims), `complete_task`, `reset_sim`.
- [ ] Scheduled `tick` reducer that calls A's `sim.ts` each second and writes the changed rows; `init`; phase → `ended` and write `result['with_lantern']`.
- [ ] Admin seed script that loads `seed/*.json` via `seed_world`.
- Done when: Prep → Fire → evacuate → reply → claim → end runs end to end from the browser.

**D — Spacetime backend, part 2 (worker + deploy) + product/pitch**
- [ ] Node Gemini worker: subscribes to `person.replyText`, classifies → `set_reply_class`; writes building explanations → `set_explanation`; stable worker identity (token file) registered as `worker`. Add those two worker-only reducers with C.
- [ ] Deploy: Vultr server (static site + worker), GoDaddy domain (MLHUTD84), Maincloud database URL in the web build.
- [ ] Public repo, README (framework list, "built this weekend").
- [ ] **Devpost by 11:00 PM** with all tracks selected (State Farm, CBRE, Spacetime + MLH opt-ins + Design).
- [ ] Attend State Farm / CBRE / Spacetime workshops if time allows (or send whoever is blocked); bring back what they want to see.
- [ ] Test the full flow every few hours; bug list for A/B/C.
- [ ] Sunday: video (≤ 2 min) by 10:30 AM, Devpost text, README final, lead pitch rehearsal. After: DEV post.

---

## 10. Timeline

| Time | Milestone |
|---|---|
| 3:30–4:30 PM | Setup. **C publishes schema + bindings**; A starts FIRMS/DINS downloads and `sim.ts`; B starts the town; D repo/domain/Vultr. |
| 4:30–8:00 PM | `sim.ts` fire + ETA (A); reducers + tick wiring (C); town on live data (B); Gemini worker skeleton + workshops (D). |
| 8:00–11:00 PM | Evacuation/check-ins/claims (A logic, C reducers); phone panel (B); worker writing back (D). **Devpost draft by 11:00 PM (D).** |
| 11 PM–3 AM | Risk model → seed (A); baseline + `result` (A+C); end screen + `/phone` pages (B); deploy to Vultr (D); first full test. |
| 3–8 AM | Sleep in shifts (A+C 3–7, B+D 5–9); bug fixes in between. |
| **9:00 AM** | **Feature freeze — fixes only.** |
| 9–11:30 AM | Video (by 10:30), Devpost text, README, rehearsal. |
| **11:30 AM** | **Submit** (hard deadline 12:00 PM, no late submissions). |
| 1–4 PM | Judging (science-fair style): D leads pitch, B drives the demo, C answers Spacetime questions, A answers fire/data/model questions. |

---

## 11. Non-negotiables
1. Numbers come from code, never from Gemini.
2. Label simulated numbers as simulated; say the neighborhood is fictional and the fire/risk are calibrated to real data.
3. Public repo, frameworks listed in README, nothing written before the event, no reused old code.
4. A working end-to-end flow by 11 PM beats a pretty half-flow at 9 AM.
5. Keep the dashboard simple: map + one building card + one phone.
