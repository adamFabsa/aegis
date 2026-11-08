/**
 * Lantern Gemini worker — a peer SpacetimeDB client.
 *  - person.replyText (free text)  → Gemini triage → set_reply_class   ('unclear' is left for humans)
 *  - building.explanation empty / still the module's template (seed, reset, every new scenario) → 2-sentence note
 *    written from the building, building_profile and fix rows → set_explanation
 * Numbers never come from Gemini: notes are written from word-only facts and rejected if they contain digits.
 */
import { config } from './config';
import { missingKey, providerName } from './gemini';
import { ReplyClassifier } from './classify';
import { ExplanationWriter } from './explain';
import { errMsg, log } from './log';
import { DbConnection } from './module_bindings';
import { NotConnectedError } from './reducerErrors';
import { readWorkerToken, saveWorkerToken } from './spacetime';
import { WorkerState } from './state';

const missing = missingKey();
if (missing) {
  log.error(`${missing} is missing (AI_PROVIDER=${config.provider}) — copy worker/.env.example to worker/.env and set it.`);
  process.exit(1);
}

const state = new WorkerState();
let conn: DbConnection | undefined;
let identityHex = '';
let stopping = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let attempt = 0;

function live(): DbConnection {
  if (!conn) throw new NotConnectedError();
  return conn;
}

let lastAuthHint = 0;
function onAuthFailure() {
  if (Date.now() - lastAuthHint < 60_000) return;
  lastAuthHint = Date.now();
  log.error(
    `"worker only": identity ${identityHex} is not the registered worker. ` +
      'Run `npm run register` in worker/ (needs the module administrator login). Results are kept and retried.',
  );
}

const classifier = new ReplyClassifier(state, {
  person: (id) => conn?.db.person.id.find(id) ?? undefined,
  setReplyClass: (personId, choice) => live().reducers.setReplyClass({ personId, choice }),
  onAuthFailure,
});

const explainer = new ExplanationWriter(state, {
  building: (id) => conn?.db.building.id.find(id) ?? undefined,
  fixes: (buildingId) => (conn ? [...conn.db.fix.iter()].filter((f) => f.buildingId === buildingId) : []),
  profile: (buildingId) => conn?.db.buildingProfile.buildingId.find(buildingId) ?? undefined,
  setExplanation: (buildingId, text) => live().reducers.setExplanation({ buildingId, text }),
  onAuthFailure,
});

/** Re-examine every row: picks up anything missed while disconnected and retries undelivered results. */
function sweep() {
  if (!conn) return;
  for (const p of conn.db.person.iter()) classifier.observe(p);
  for (const b of conn.db.building.iter()) explainer.observe(b);
}

function scheduleReconnect(reason: string) {
  conn = undefined;
  if (stopping || reconnectTimer) return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 500);
  attempt++;
  log.warn(`reconnecting in ${Math.round(delay / 1000)}s`, { reason, attempt });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

function connect() {
  log.info('connecting to SpacetimeDB', { server: config.server, database: config.database });
  const token = readWorkerToken();
  try {
    DbConnection.builder()
      .withUri(config.server)
      .withDatabaseName(config.database)
      .withToken(token)
      .onConnect((c, identity, newToken) => {
        attempt = 0;
        conn = c;
        identityHex = identity.toHexString();
        saveWorkerToken(newToken);
        log.info(`connected — worker identity ${identityHex}`);

        c.db.person.onInsert((_ctx, row) => classifier.observe(row));
        c.db.person.onUpdate((_ctx, _old, row) => classifier.observe(row));
        c.db.building.onInsert((_ctx, row) => explainer.observe(row));
        c.db.building.onUpdate((_ctx, _old, row) => explainer.observe(row));
        // A new scenario rewrites construction: re-check that building (callbacks run once the whole transaction is applied).
        const profileChanged = (buildingId: number) => {
          const b = c.db.building.id.find(buildingId);
          if (b) explainer.observe(b);
        };
        c.db.buildingProfile.onInsert((_ctx, row) => profileChanged(row.buildingId));
        c.db.buildingProfile.onUpdate((_ctx, _old, row) => profileChanged(row.buildingId));

        c.subscriptionBuilder()
          .onApplied(() => {
            log.info('subscribed', {
              people: [...c.db.person.iter()].length,
              buildings: [...c.db.building.iter()].length,
              fixes: [...c.db.fix.iter()].length,
            });
            sweep();
          })
          .onError((ctx) => {
            log.error('subscription error', { error: errMsg((ctx as { event?: unknown }).event ?? ctx) });
            c.disconnect();
          })
          .subscribe(['SELECT * FROM person', 'SELECT * FROM building', 'SELECT * FROM fix', 'SELECT * FROM building_profile']);
      })
      .onConnectError((_ctx, error) => {
        const m = errMsg(error);
        if (token && /401|unauthori[sz]ed|invalid token/i.test(m))
          log.error(`saved token in ${config.tokenFile} was rejected; delete it only if you intend to get (and re-register) a new identity`);
        scheduleReconnect(`connect error: ${m}`);
      })
      .onDisconnect((_ctx, error?: Error) => {
        scheduleReconnect(error ? `disconnected: ${errMsg(error)}` : 'disconnected');
      })
      .build();
  } catch (e) {
    scheduleReconnect(`build failed: ${errMsg(e)}`);
  }
}

const sweepTimer = setInterval(sweep, 30_000);

function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} — shutting down`);
  clearInterval(sweepTimer);
  clearTimeout(reconnectTimer);
  state.flush();
  try {
    conn?.disconnect();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: errMsg(e) }));

log.info('Lantern AI worker starting', { provider: providerName() });
connect();
