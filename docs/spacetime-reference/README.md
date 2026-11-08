# Tested SpacetimeDB reference (for C and B)

`index.ts` is a complete Lantern module (spec schema + every reducer) wired to `spacetimedb/src/sim.ts`.
`clients_test.ts` drives it with two real client connections (generated TypeScript bindings).

Verified on a local SpacetimeDB **2.14.1** server (npm `spacetimedb@2.14.0`):

| Check | Result |
|---|---|
| `spacetime build` + strict `tsc` | clean |
| `init` seeds the world from `seed_data.ts` | 8 buildings, 260 people, 1,550 fire cells, 20+ fixes |
| Scheduled `tick` (`ScheduleAt.interval(1 s)`) | exactly 1 tick/s, ~0.9 ms per tick inside the module |
| 10 simultaneous `claim_task` calls on one task | 1 wins, 9 get `already claimed by …` |
| Two clients (different identities) | reply → task visible on the other client in ~4 ms; identical fire grids |
| Scripted demo in the module vs in Node | identical results (tick 149, 260/260 vs 253/260) |
| Module logs | only the expected `SenderError`s from the tests, no panics |

## Things that bit us (2.14 TypeScript)

- Scheduled reducer syntax is `spacetimedb.reducer({ onSchedule: simTick }, { timer: simTick.rowType }, (ctx, { timer }) => …)`.
- Exports are camelCase in TS (`claimTask`) but reducers are **snake_case** on the wire and in the CLI
  (`spacetime call <db> claim_task 3 '"Alex"'`). SQL columns are snake_case too (`sim_minutes`).
- The module entry file may only export SpacetimeDB values (schema default, reducers, lifecycle).
  Import `sim.ts` as `import * as S from './sim'`; don't re-export its helpers.
- Rows from `ctx.db` are readonly — spread-copy before passing them to `sim.ts`.
- Pass structured data as typed reducer args, not JSON strings; the seed is imported from `seed_data.ts`.
- `spacetime.local.json` from the template overrides the database name; use `--no-config` with explicit names
  when scripting the CLI.
- Client side: reducer calls return a Promise that **rejects with the SenderError message**
  (`await conn.reducers.claimTask({ taskId, staffName })`); `table.count()` returns a **bigint**;
  `u64` ids are bigint; subscribe with `subscriptionBuilder().onApplied(...).subscribeToAllTables()`.
- `spacetime start --listen-addr 127.0.0.1:3555 --data-dir <dir>` runs a private local server without
  touching the default one; pass `--server http://127.0.0.1:3555` to publish/call/sql.

## Re-run

```bash
spacetime init --lang typescript --server-only --local --non-interactive --project-path /tmp/lt lantern-test
cp spacetimedb/src/sim.ts spacetimedb/src/seed_data.ts docs/spacetime-reference/index.ts /tmp/lt/spacetimedb/src/
(cd /tmp/lt/spacetimedb && npm install)
spacetime start --listen-addr 127.0.0.1:3555 --data-dir /tmp/lt-data &
spacetime publish --no-config lantern-test --server http://127.0.0.1:3555 --module-path /tmp/lt/spacetimedb --yes
spacetime generate --no-config --lang typescript --out-dir /tmp/lt-client/bindings --module-path /tmp/lt/spacetimedb
# then: npm i spacetimedb@2.14.0 tsx in /tmp/lt-client, copy clients_test.ts there, `npx tsx clients_test.ts`
```
