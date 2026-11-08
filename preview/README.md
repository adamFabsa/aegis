# Lantern sim preview

`preview/index.html` — open it in any browser (double-click; no server, no install). It runs the **same engine
as the Spacetime module** (`spacetimedb/src/sim.ts` + the generated seed), single-player, so you can:

- check the fire and evacuation look right without waiting for the live app,
- give B a visual reference for every status, number and event,
- fall back to it for the demo if the live integration is late.

Controls: Start fire / Back to prep, Play / Step / End & compare, sim minutes per tick, ticks per second,
fire seed. Click a building for its card (fixes in prep; start evacuation in the fire phase); the phone
panel has the resident check-in and the staff task list (claim / done).

URL options: `?demo=1` (the spec §8 demo plays itself), `&play=1`, `&rate=20` (ticks per second),
`&speed=5` (sim minutes per tick), `&seed=123` (another fire), `&recommend=1` (approve recommended fixes),
`&select=9`, `&tab=staff`, `&until=40` (pause at tick 40), `&selftest=1` (clicks through the whole UI and
writes PASS/FAIL into `body[data-selftest]`).

Rebuild after changing `sim.ts`, the seed or `preview/app.js`:

```bash
node --experimental-strip-types preview/build.ts
node --experimental-strip-types --test preview/test_preview.ts
```
