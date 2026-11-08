# Aegis

Wildfire preparedness and evacuation simulation for property managers (HackUTD 2026). Built during the event.

- **Part A — data, model, simulation engine:** [`data/`](data/README.md) (NASA FIRMS + IEM wind → fire calibration,
  CAL FIRE DINS → building risk model, Tiger Data loader), [`spacetimedb/src/sim.ts`](spacetimedb/SIM.md) (the
  engine), [`seed/`](seed/README.md), and [`preview/`](preview/README.md) (the engine in a browser, no server needed).
- **Part C — SpacetimeDB backend:** state, transactional game actions, the scheduled tick, auth, seed
  administration and generated client bindings ([`docs/backend.md`](docs/backend.md)).
- **Part B — website:** [`web/`](web/README.md) (React + Vite isometric town with Blender-rendered sprites, dashboard,
  resident/staff phones) rendering the live module; [`blender/`](blender/README.md) builds the sprites.
- **Part D — AI worker (Claude):** [`worker/`](#ai-worker-claude) — a Node client of the same database that triages
  free-text resident replies and writes each building's plain-English risk note.
- Hosting (Vultr) and the domain are deployment steps, not code in this repository.

**What is real and what is simulated.** The neighborhood, residents and dollar values are **fictional (simulated)**.
The fire is calibrated to the real 2025 Eaton Fire (NASA FIRMS front speed 1.92 km/h, Burbank wind replay), and
building risk comes from a model trained on 35,062 CAL FIRE damage inspections. See [`data/README.md`](data/README.md).

## What the demo shows

- **Aegis AI coach (the phone).** Before the fire it ranks fixes like the server's `approve_recommended`: residents
  who need help first, then expected insurance claims avoided per dollar (value × chance the fire reaches the building
  × the CAL FIRE model's risk). During the fire it answers State Farm's question: who has the most urgent need (send
  staff in one tap), which buildings to evacuate before the fire arrives, where to send engines ahead of it, and who
  has not answered yet. Every number comes from the model and the simulation; Claude (Anthropic API, structured outputs) reads residents'
  free-text replies and writes the per-building notes, never numbers.
- **Random scenarios (`new_scenario`).** Same town, new world: wind, where the fire starts (or click to pick it,
  `set_ignition`), every building's construction re-scored by the bundled CAL FIRE model (`risk_model.ts`), residents'
  needs, and fire arrival / reach re-simulated (160 runs). Same number → same world; 0 = the Eaton demo map.
- **A fair comparison.** "With Aegis" and "without Aegis" burn the same fire: every spread link and building has
  one fixed random threshold for the whole fire, so a fix, a lower risk or an engine on scene can only delay or prevent
  a burn. Across 40 worlds Aegis's plan is never worse on damage, buildings lost or people
  (`spacetimedb/tests/scenario.test.ts`). The demo fire is the *representative* one, not the most flattering
  (`data/sim/pick_demo_seed.ts`).
- **Fire engines (`unit` table).** Auto-dispatched to burning buildings (one held in reserve); the coach can send one
  ahead of the fire, where it stands by and lowers that building's ignition odds; hoses only on burning buildings.

## Local setup

Use SpacetimeDB **2.14.1** and a Node version supported by its SDK: `^22.23.4`, `^24.22.1`, or `>=26.12.1`.

```bash
npm ci
npm ci --prefix spacetimedb
# Install the CLI from https://spacetimedb.com/install if it is not already installed.
spacetime version install 2.14.1
spacetime version use 2.14.1
npm run spacetime -- start --listen-addr 127.0.0.1:3000
```

In a second terminal:

```bash
npm run publish:local   # init loads A's calibrated seed — playable immediately
npm run bindings
npm run check:all       # type-check, engine + preview tests, module build
npm run smoke           # disposable database only (see below)
npm run seed            # optional: re-send seed/*.json through the admin seed_world reducer
```

Then the website: `npm run web:dev` (or `cd web && npm ci && npm run dev`) and open http://localhost:5173 —
`?view=phone` for the phone, `?mock=1` for the offline demo (see [`web/README.md`](web/README.md)).

`bash data/run_pipeline.sh` (or `npm run pipeline`) rebuilds the seed, `seed_data.ts` and the preview from the public data.

The npm scripts use `spacetime` on PATH, or the workspace-local `.tools/spacetime/spacetime` installation when present. `npm run spacetime -- <arguments>` exposes the same CLI wrapper. The local database is `lantern` at `http://127.0.0.1:3000` (WebSocket clients may also use `ws://127.0.0.1:3000`).

`npm run smoke` **replaces state in its target database**. Run it only against a disposable local database. It tests competing claims from independent clients, ownership, worker authorization, fixes, rollback of an invalid seed, scheduled ticking/escalation, results, baseline and reset. It restores the default development seed after success. `npm test` tests the pure simulation and seed contract without a server.

## Maincloud handoff

Maincloud has **not** been published from this environment; the requested handoff is local setup plus publishing instructions.

```bash
npm run spacetime -- login
# Choose a unique name if "lantern" is already taken; change spacetime.json's database too.
npm run publish:maincloud
SPACETIME_SERVER=https://maincloud.spacetimedb.com SPACETIME_DATABASE=lantern npm run seed
npm run bindings
```

Publishing does not automatically erase an existing database. Review schema conflicts before allowing any migration that deletes data. The publishing identity becomes the administrator at initial creation; retain its login. The seed script reads that CLI login internally or accepts `SPACETIME_TOKEN` from the environment. Tokens must never be put in frontend code or committed.

Point B's frontend and D's worker at the published database and server. D registers the worker's stable identity using the administrator's `register_worker` reducer; anonymous clients cannot grant themselves worker access.

## Local server recovery

During verification, one hot update on SpacetimeDB 2.14.1 timed out and its
server then stalled during shutdown. If a local instance remains locked, stop
that specific local process before restarting it. For an isolated verification
run, use a fresh data directory and an unused port; set `SPACETIME_SERVER` to
that same port for seed/smoke scripts. No Maincloud database was affected.

## Team handoff

- [Public schema](spacetimedb/src/schema.ts) preserves every section 4 public table/column. Private tables store administrator/worker identities, the original seed, simulation bookkeeping, and claim ownership.
- [Reducers and one-second scheduler](spacetimedb/src/index.ts) enforce phases, budget, atomic claims and authenticated worker writes.
- [Generated TypeScript bindings](web/src/module_bindings/index.ts) are ready for B and D. They were generated by the 2.14.1 CLI and should be committed.
- [Simulation contract](spacetimedb/src/model.ts) and [reference engine](spacetimedb/src/sim.ts) give A a working integration target; the engine runs inside SpacetimeDB, including the no-Aegis comparison.
- [Backend contract and integration examples](docs/backend.md) document reducer arguments, subscriptions, seed format and ownership.

Evacuation time uses A's staff × van bottleneck model (the brief's linear formula could not give both pitch numbers): Building 12 needs **3h00m → 1h35m** with a second van, against a fire that reaches it in about 1h44m.

## AI worker (Claude)

[`worker/`](worker/) is a Node 22+ TypeScript process that connects to the SpacetimeDB database as an ordinary client
(the same generated bindings, copied to `worker/src/module_bindings`) and writes back through two worker-only reducers.
It calls **Claude** (Anthropic API, `claude-opus-5-5`, structured outputs, low effort) through `@anthropic-ai/sdk`.

- **Reply triage.** Subscribes to `person`. When a pinged resident's `replyText` is new, Claude classifies it with a
  JSON-schema output (enum) as `safe` / `cant_move` / `needs_medical` / `unclear`, and the worker calls
  `set_reply_class`. `unclear` is not sent: the resident stays pinged and the normal 10-minute escalation applies.
  Each (check-in, text) pair is classified once — results persist in `worker/.worker-state.json`, and work is
  serialized per person so a stale answer is dropped if the resident types again mid-request.
- **Building notes.** Subscribes to `building`, `building_profile` and `fix`. A building whose `explanation` is empty
  or still the module's template gets a two-sentence instruction ("what to do first to save this building, and why")
  via `set_explanation`. Claude only sees **word facts** computed in code (risk band, the model's top drivers,
  construction from `building_profile`, whether evacuation is slower than the fire, fixes ranked by the model). Any
  note containing a digit that is not part of a code-supplied fix name is rejected and retried, so **every number on
  screen still comes from code**. Notes are cached by their facts; random scenarios get fresh notes.
- **Identity.** The first connection's token is saved to `worker/.worker-token` (gitignored) so the identity is stable;
  it is printed on startup. The module administrator authorizes it once with `register_worker`.
- **Resilience.** Reconnects with exponential backoff (1 s → 30 s), re-sweeps all rows every 30 s and after each
  reconnect, retries 429/5xx, paces calls client-side, and always serves resident replies before building notes.
  Server-side refusal fallbacks are on. (`AI_PROVIDER=gemini` switches the same calls to the Gemini API.)

```bash
cd worker
npm install
cp .env.example .env          # set ANTHROPIC_API_KEY; SPACETIME_SERVER / SPACETIME_DATABASE (hosted: https://maincloud.spacetimedb.com / aegis-hackutd)
npm start                     # prints "connected — worker identity <hex>" and saves .worker-token
npm run register              # once, as the publishing account (spacetime login, or SPACETIME_TOKEN in .env)
npm run dev                   # same as start, restarts on file changes
npm run check                 # type-check
npm test                      # facts / template / scenario tests (no AI calls)
npm run e2e                   # full loop against a DISPOSABLE database (E2E_STUB_MODEL=1 uses a local stand-in model)
npm run bindings              # regenerate worker/src/module_bindings from ../spacetimedb (needs the spacetime CLI)
```

Until `npm run register` runs, the worker logs a `"worker only"` hint and keeps its results to retry. `.env`,
`.worker-token` and `.worker-state.json` are gitignored — never commit them.

## Frameworks and libraries

All code here was written for this build. Dependencies: SpacetimeDB 2.14.1 (server runtime, realtime SDK and generated bindings), TypeScript (types/compiler), tsx (TypeScript script runner), and `@types/node` (Node types). Tests use Node's built-in test/assert modules. SpacetimeDB's CLI builds/bundles and generates the client bindings. Data pipeline (Python): pandas, NumPy, scikit-learn, psycopg 3; Tiger Data (managed TimescaleDB) for the FIRMS hypertable. Preview fonts: Inter and Space Grotesk (Google Fonts). Data: NASA FIRMS, Iowa Environmental Mesonet (ASOS), CAL FIRE DINS. All four parts are in this repository. Hosted on Vercel (website) and SpacetimeDB Maincloud (database): https://aegis-beta-nine.vercel.app

Full list:

| Kind | Name | Used for |
|---|---|---|
| Database / runtime | SpacetimeDB 2.14.1 (Maincloud, CLI, `spacetimedb` npm SDK) | module, scheduled simulation, realtime clients, generated bindings |
| Language / tooling | TypeScript 5, tsx, `@types/node`, Node.js 22+ (built-in `node:test`, `--env-file`) | module, scripts, tests, worker |
| AI | Claude via the Anthropic API (`@anthropic-ai/sdk`, `claude-opus-5-5`, structured outputs) | worker: reply triage, building notes |
| Website | React 19, Vite 8, TypeScript 7, oxlint, qrcode-generator | dashboard, phones, isometric town |
| 3D / art | Blender (Python scripts in `blender/`) | building, vehicle and ground sprites |
| Data (Python) | pandas, NumPy, scikit-learn, psycopg 3 | pipeline, risk model |
| Database | Tiger Data (managed PostgreSQL + TimescaleDB) | FIRMS hypertable, DINS table |
| Data sources / APIs | NASA FIRMS, Iowa Environmental Mesonet ASOS, CAL FIRE DINS | fire calibration, wind replay, risk model |
| Fonts | Inter, Space Grotesk (Google Fonts) | preview |

API choices were checked against the [official scheduler documentation](https://spacetimedb.com/docs/tables/schedule-tables/) and [CLI configuration documentation](https://spacetimedb.com/docs/cli-reference/spacetime-json/), then verified with the pinned SDK and a real local database.
