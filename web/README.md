# Lantern web (Part B)

Isometric town (Blender-rendered sprites, see `../blender/README.md`), the manager's dashboard, and the resident /
staff phone. It renders the **live SpacetimeDB module** (Part C's reducers driving Part A's engine) through the
generated bindings in `src/module_bindings/`.

```bash
npm ci
npm run dev          # http://localhost:5173 — needs the module running (see ../README.md)
npm run build        # type-check + production build into dist/
npm run lint
```

## Which server

| Setting | How |
|---|---|
| Build-time default | `VITE_SPACETIME_URI` (e.g. `wss://maincloud.spacetimedb.com`) and `VITE_SPACETIME_DB` in `web/.env` |
| Per page | `?server=ws://127.0.0.1:3000&db=lantern` |
| Fallback | `ws://127.0.0.1:3000`, database `lantern` |

If the server can't be reached the page says so and offers the offline demo.

## Modes and deep links

- `?mock=1` — B's offline stand-in world (`src/town/mockWorld.ts`, no server; numbers are placeholders).
- `?view=phone&role=resident&id=1201` — full-screen phone (Maria R.); `&role=staff&name=Alex` for staff.
  Each browser keeps its own identity (token in localStorage), which is what lets only the claiming staff member
  complete a task.
- `?prep=12&phase=fire&evac=12&ticks=30&select=12` — demo deep link (approves van + brush, starts the fire,
  evacuates, skips ahead). It acts on the shared database, so everyone watching sees it.
- `?look=night|dusk|maquette`, `?rot=0..3` — art direction and camera.

## How the live data maps onto the UI

`src/town/liveWorld.ts` implements the same `WorldApi` (`src/town/world.ts`) as the mock: table rows become the
`Building` / `Person` / `Task` / `FireCell` shapes in `src/town/types.ts`; every button calls a reducer and shows its
error text (e.g. "already claimed by Alex"). Burn stages, damage and the ember-cooling animation are derived on the
client from building status + fire cells. Fire units (incident command) exist only in the mock for now, so the
live dashboard hides them.
