/**
 * End-to-end test of the worker against a DISPOSABLE database (it resets the sim and starts a fire).
 *   SPACETIME_SERVER=http://127.0.0.1:3000 SPACETIME_DATABASE=<test db> SPACETIME_TOKEN=<admin token> npm run e2e
 * Flow: register_worker → worker writes notes → scenario #7, then #11 while #7's notes are in flight → every note is
 * rewritten from #11's construction → back to the Eaton demo from the cache → fire + evacuation → residents text →
 * worker classifies (cant_move / needs_medical applied, unclear left alone) → restarted worker re-classifies nothing.
 * ~4 min, ~25 model calls. Without a key or quota: E2E_STUB_MODEL=1 (a local stand-in model, see stubModel.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, WORKER_DIR } from './config';
import { buildFacts, factsBasis, isTemplate, validateNote } from './explain';
import { errMsg, log } from './log';
import type { DbConnection } from './module_bindings';
import { openConnection } from './spacetime';
import type { ExplanationRecord } from './state';
import { startStubModel, type StubModel } from './stubModel';
import { readFileSync } from 'node:fs';

const MARIA = 1201, ROBERT = 1202, RAJ = 1203;
const REPLIES: Array<[number, string, string[]]> = [
  [MARIA, "I'm in my wheelchair on the third floor and the elevator is off, I can't get down", ['cant_move']],
  [ROBERT, 'my oxygen is running out and the smoke makes it really hard to breathe', ['cant_move']], // needs_medical → urgent cant_move
  [RAJ, 'what floor is the cafeteria on?', ['pinged']], // unclear → untouched
];

if (/maincloud/i.test(config.server) && process.env.E2E_ALLOW_REMOTE !== '1') {
  log.error('refusing to run e2e against Maincloud (it resets the sim). Use a disposable DB, or set E2E_ALLOW_REMOTE=1.');
  process.exit(2);
}
const adminToken = process.env.SPACETIME_TOKEN?.trim();
if (!adminToken) {
  log.error('set SPACETIME_TOKEN to the administrator (publisher) token of the test database');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'lantern-e2e-'));
const childEnv: NodeJS.ProcessEnv = { ...process.env, WORKER_TOKEN_FILE: join(tmp, 'token'), WORKER_STATE_FILE: join(tmp, 'state.json') };
let stub: StubModel | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string, data?: Record<string, unknown>) => {
  if (!ok) failures++;
  log[ok ? 'info' : 'error'](`${ok ? 'PASS' : 'FAIL'} ${what}`, data);
};

async function waitFor(what: string, pred: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(500);
  }
  log.warn(`timed out waiting for ${what}`);
  return false;
}

function run(script: string, tag: string, lines: string[]): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: WORKER_DIR, env: childEnv });
  for (const s of [child.stdout, child.stderr])
    s?.on('data', (d: Buffer) => {
      for (const l of d.toString().split(/\r?\n/)) if (l.trim()) {
        lines.push(l);
        console.log(`  [${tag}] ${l.slice(25, 260)}`);
      }
    });
  return child;
}
const exited = (c: ChildProcess) => new Promise<number>((r) => c.on('exit', (code) => r(code ?? 1)));

function subscribeAll(conn: DbConnection) {
  return new Promise<void>((resolve, reject) =>
    conn.subscriptionBuilder().onApplied(() => resolve()).onError((ctx) => reject((ctx as { event?: unknown }).event)).subscribeToAllTables(),
  );
}

async function main() {
  if (process.env.E2E_STUB_MODEL === '1') {
    stub = await startStubModel();
    Object.assign(childEnv, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'stub', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: stub.url });
    log.info('E2E_STUB_MODEL=1: the worker talks to a local stand-in model (no AI calls)', { url: stub.url });
  }
  const seed = JSON.parse(readFileSync(config.seedBuildings, 'utf8')) as { buildings: Array<{ id: number; kind: string; explanation: string; fixes: Array<{ name: string }> }> };
  const { conn: admin } = await openConnection(adminToken);
  await subscribeAll(admin);
  await admin.reducers.newScenario({ number: 0 });
  log.info('back to the Eaton demo map (explanations back to seed templates)');

  // Record each test resident's first status after being pinged.
  const firstAfterPing = new Map<number, string>();
  admin.db.person.onUpdate((_c, old, row) => {
    if (old.status === 'pinged' && row.status !== 'pinged' && !firstAfterPing.has(row.id)) firstAfterPing.set(row.id, row.status);
  });

  // 1. register
  const regLines: string[] = [];
  check((await exited(run('src/register.ts', 'register', regLines))) === 0, 'npm run register');

  // 2. worker writes notes
  const lines: string[] = [];
  let worker = run('src/index.ts', 'worker', lines);
  const targets = seed.buildings.filter((b) => b.kind !== 'shelter');
  const written = () => targets.every((b) => {
    const e = admin.db.building.id.find(b.id)?.explanation ?? '';
    return e && e !== b.explanation;
  });
  check(await waitFor('notes', written, 6 * 60_000), 'worker wrote a Gemini note for every non-shelter building');
  for (const b of targets) {
    const text = admin.db.building.id.find(b.id)?.explanation ?? '';
    const problem = validateNote(text, b.fixes.map((f) => f.name));
    check(!problem && text !== b.explanation, `note for building ${b.id} has no invented numbers`, { text, problem });
  }
  check(admin.db.building.id.find(99)?.explanation === seed.buildings.find((b) => b.id === 99)?.explanation, 'shelter note left alone');

  // 2b. random scenarios rebuild construction, risk, fixes and every template. Switch to #11 while #7's notes are
  //     still being written: each final note must be the worker's, written from #11's building_profile rows.
  //     (Texts may repeat across scenarios, so "written for this scenario" is read from the worker's state file.)
  const sentNotes = (): Record<string, ExplanationRecord> => {
    try {
      return (JSON.parse(readFileSync(childEnv.WORKER_STATE_FILE!, 'utf8')) as { explanations?: Record<string, ExplanationRecord> }).explanations ?? {};
    } catch {
      return {};
    }
  };
  /** The row shows the worker's note, and the worker wrote it from the building's current scenario facts. */
  const current = (id: number, sent = sentNotes()) => {
    const row = admin.db.building.id.find(id);
    if (!row || !row.explanation.trim() || isTemplate(row.explanation)) return false;
    const fixes = [...admin.db.fix.iter()].filter((f) => f.buildingId === id);
    const rec = sent[id];
    return rec?.text === row.explanation && rec.basis === factsBasis(buildFacts(row, fixes, admin.db.buildingProfile.buildingId.find(id) ?? undefined));
  };
  const allCurrent = () => {
    const sent = sentNotes();
    return targets.every((b) => current(b.id, sent));
  };
  const eatonNotes = new Map(targets.map((b) => [b.id, admin.db.building.id.find(b.id)?.explanation ?? '']));
  await admin.reducers.newScenario({ number: 7 });
  await waitFor('a first scenario #7 note', () => targets.some((b) => current(b.id)), 2 * 60_000);
  await admin.reducers.newScenario({ number: 11 });
  log.info('scenario #7, then #11 while #7 notes were still being written');
  check(await waitFor('scenario #11 notes', allCurrent, 6 * 60_000), 'worker rewrote every note for scenario #11');
  await sleep(4000); // a late #7 note would have landed (and been replaced) by now
  await waitFor('scenario #11 notes (settled)', allCurrent, 2 * 60_000);
  const sent = sentNotes();
  for (const b of targets) {
    const row = admin.db.building.id.find(b.id)!;
    const problem = validateNote(row.explanation, [...admin.db.fix.iter()].filter((f) => f.buildingId === b.id).map((f) => f.name));
    check(!problem && current(b.id, sent), `scenario #11 note for building ${b.id} is written from its new construction`, { text: row.explanation, problem });
  }
  const mark = lines.length;
  await admin.reducers.newScenario({ number: 0 });
  const eatonAgain = () => targets.every((b) => admin.db.building.id.find(b.id)?.explanation === eatonNotes.get(b.id));
  check(await waitFor('Eaton demo notes again', eatonAgain, 2 * 60_000), 'back to the Eaton demo: the same notes as before');
  check(!lines.slice(mark).some((l) => l.includes('writing building note')), 'back to the Eaton demo: notes came from the cache (no model calls)');

  // 3. fire + evacuation + free-text replies
  await admin.reducers.setSpeed({ minutesPerTick: 1 });
  await admin.reducers.setPhase({ phase: 'fire' });
  await admin.reducers.startEvacuation({ buildingId: 12 });
  for (const [personId, text] of REPLIES) await admin.reducers.replyCheckin({ personId, choice: 'text', text });
  log.info('sent free-text replies', { people: REPLIES.map((r) => r[0]) });

  const classified = (id: number) => lines.some((l) => l.includes('reply classified') && l.includes(`"personId":${id}`));
  await waitFor('classifications', () => REPLIES.every(([id]) => classified(id)), 3 * 60_000);
  await sleep(3000);
  for (const [id, text, expected] of REPLIES) {
    const got = firstAfterPing.get(id) ?? admin.db.person.id.find(id)?.status ?? '?';
    const line = lines.find((l) => l.includes('reply classified') && l.includes(`"personId":${id}`));
    check(expected.includes(got), `resident ${id} → ${got}`, { text, expected, gemini: line?.match(/"category":"(\w+)"/)?.[1] });
  }
  check(lines.some((l) => l.includes('unclear reply') && l.includes(`"personId":${RAJ}`)), 'unclear reply not sent to set_reply_class');
  check(!lines.some((l) => /set_reply_class (failed|rejected)/.test(l)), 'no set_reply_class failures');

  // 4. restart: nothing is classified or written again
  worker.kill();
  await exited(worker);
  const before = lines.length;
  worker = run('src/index.ts', 'worker#2', lines);
  await waitFor('reconnect', () => lines.slice(before).some((l) => l.includes('subscribed')), 30_000);
  await sleep(8000);
  const again = lines.slice(before).filter((l) => /classifying reply|writing building note/.test(l));
  check(again.length === 0, 'restarted worker re-asks Gemini for nothing', { again: again.length });
  worker.kill();
  await exited(worker);

  await admin.reducers.resetSim({});
  admin.disconnect();
}

main()
  .catch((e) => {
    failures++;
    log.error('e2e crashed', { error: errMsg(e) });
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (stub) log.info('stub model requests', { notes: stub.requests.filter((r) => r.kind === 'note').length, triage: stub.requests.filter((r) => r.kind === 'triage').length });
    void stub?.close();
    log[failures ? 'error' : 'info'](failures ? `e2e: ${failures} failure(s)` : 'e2e: all checks passed');
    setTimeout(() => process.exit(failures ? 1 : 0), 300);
  });
