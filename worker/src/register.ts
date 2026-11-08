/**
 * One-time: authorize this worker's identity via the administrator-only `register_worker` reducer.
 * The administrator is the identity that first published the module (its `spacetime login`).
 *   npm run register            # admin token from SPACETIME_TOKEN, else `spacetime login show --token`
 */
import { spawnSync } from 'node:child_process';
import { config } from './config';
import { errMsg, log } from './log';
import { openConnection, readWorkerToken, saveWorkerToken } from './spacetime';

function adminToken(): string {
  const fromEnv = process.env.SPACETIME_ADMIN_TOKEN?.trim() || process.env.SPACETIME_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync(process.env.SPACETIME_CLI ?? 'spacetime', ['login', 'show', '--token'], { encoding: 'utf8', timeout: 60_000 });
  const token = `${r.stdout ?? ''}`.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/)?.[0];
  if (!token) throw new Error('No admin token: run `spacetime login` (as the publishing account) or set SPACETIME_TOKEN in worker/.env');
  return token; // never printed
}

async function main() {
  // 1. Worker identity (creates and saves one if this is the first run).
  const worker = await openConnection(readWorkerToken());
  saveWorkerToken(worker.token);
  const hex = worker.identity.toHexString();
  log.info(`worker identity ${hex}`);

  // 2. Register it as administrator.
  const admin = await openConnection(adminToken());
  log.info(`administrator connection identity ${admin.identity.toHexString()}`);
  try {
    await admin.conn.reducers.registerWorker({ identity: worker.identity });
    log.info('register_worker ok — this worker may now call set_reply_class / set_explanation', { database: config.database });
  } finally {
    admin.conn.disconnect();
    worker.conn.disconnect();
  }
}

main()
  .then(() => setTimeout(() => process.exit(0), 200))
  .catch((e) => {
    log.error('register failed', { error: errMsg(e) });
    if (/administrator only/i.test(errMsg(e))) log.error('That login is not the account that published the module.');
    setTimeout(() => process.exit(1), 200);
  });
