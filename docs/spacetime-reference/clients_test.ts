// Two real client connections (separate identities) against the local SpacetimeDB test server:
// live subscriptions, cross-client latency, an atomic claim race between two users, cache consistency.
import { DbConnection } from './bindings/index';

const URI = 'ws://127.0.0.1:3555';
const DB = 'lantern-test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

function connect(label: string): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect((c, identity) => {
        console.log(`${label} connected as ${identity.toHexString().slice(0, 12)}…`);
        c.subscriptionBuilder()
          .onApplied(() => resolve(c))
          .onError((_ctx: unknown, err: unknown) => reject(err))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => reject(err))
      .build();
    void conn;
  });
}

async function main() {
  const A = await connect('dashboard (A)');
  const B = await connect('staff phone (B)');
  check(A.identity?.toHexString() !== B.identity?.toHexString(), 'A and B are different identities');

  // Fresh world.
  await A.reducers.resetSim({});
  await sleep(300);
  check(Number(B.db.fireCell.count()) === 1550, `B sees all 1550 fire cells (got ${B.db.fireCell.count()})`);
  check(Number(B.db.person.count()) === 260, `B sees 260 people (got ${B.db.person.count()})`);
  check([...B.db.sim.iter()][0]?.phase === 'prep', 'B sees phase = prep');

  // Prep from A, visible on B.
  await A.reducers.approveFix({ fixId: 121 });
  await sleep(200);
  check(B.db.building.id.find(12)?.vans === 2, 'B sees Building 12 get its second van');
  let err = '';
  try {
    await B.reducers.approveFix({ fixId: 121 });
  } catch (e) {
    err = String((e as Error).message ?? e);
  }
  check(/already approved/.test(err), `B approving the same fix is rejected (“${err}”)`);

  // Fire + evacuation.
  await A.reducers.setPhase({ phase: 'fire' });
  await A.reducers.startEvacuation({ buildingId: 12 });

  // Cross-client latency: A's reply → B sees the new task.
  const seen = new Promise<number>((resolve) => {
    const t0 = now();
    B.db.task.onInsert((_ctx, row) => {
      if (row.personId === 1201) resolve(now() - t0);
    });
  });
  await A.reducers.replyCheckin({ personId: 1201, choice: 'cant_move', text: '' });
  const latency = await Promise.race([seen, sleep(3000).then(() => -1)]);
  check(latency >= 0, `B sees Maria's urgent task ${latency.toFixed(0)} ms after A's reply`);
  const maria = [...B.db.task.iter()].find((t) => t.personId === 1201);
  check(!!maria && maria.priority === 3 && maria.claimedBy === '', 'Maria task: priority 3, unclaimed');

  // Claim race between two different users, same instant.
  const taskId = maria!.id;
  const results = await Promise.allSettled([
    A.reducers.claimTask({ taskId, staffName: 'Alex' }),
    B.reducers.claimTask({ taskId, staffName: 'Sam' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const rej = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  check(ok === 1 && rej.length === 1, `exactly one claim wins (${ok} won, ${rej.length} rejected: “${rej[0]?.reason?.message ?? rej[0]?.reason}”)`);
  await sleep(200);
  const a = A.db.task.id.find(taskId)?.claimedBy;
  const b = B.db.task.id.find(taskId)?.claimedBy;
  check(!!a && a === b, `both screens agree Maria is claimed by ${a}`);
  check(B.db.person.id.find(1201)?.status === 'claimed', 'Maria shows as claimed');

  // Live ticks reach both clients.
  let simUpdates = 0;
  let cellUpdates = 0;
  B.db.sim.onUpdate(() => simUpdates++);
  B.db.fireCell.onUpdate(() => cellUpdates++);
  const t1 = [...B.db.sim.iter()][0]!.tick;
  await sleep(5200);
  const t2 = [...B.db.sim.iter()][0]!.tick;
  check(t2 - t1 >= 4 && t2 - t1 <= 6, `≈1 tick per second reaches B (${t2 - t1} ticks in 5.2 s)`);
  check(simUpdates >= 4, `B got ${simUpdates} sim updates and ${cellUpdates} fire-cell updates`);
  const hash = (c: DbConnection) => [...c.db.fireCell.iter()].sort((x, y) => x.id - y.id).map((x) => x.state).join('');
  await sleep(100);
  check(hash(A) === hash(B), 'A and B have identical fire grids');

  // Finish the job, end the fire, compare.
  await B.reducers.completeTask({ taskId });
  await sleep(200);
  check(A.db.person.id.find(1201)?.status === 'out', 'A sees Maria out after B completes the task');
  await A.reducers.endAndCompare({});
  await sleep(300);
  const res = [...A.db.result.iter()];
  const w = res.find((r) => r.scenario === 'with_lantern');
  const wo = res.find((r) => r.scenario === 'without_lantern');
  check(!!w && !!wo, `results written: with ${w?.peopleSafe}/${w?.peopleTotal} safe, ${w?.buildingsLost} lost | without ${wo?.peopleSafe}/${wo?.peopleTotal}, ${wo?.buildingsLost} lost`);
  check([...B.db.sim.iter()][0]?.phase === 'ended', 'B sees phase = ended');

  A.disconnect();
  B.disconnect();
  console.log(failures === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('client test crashed:', e);
  process.exit(2);
});
