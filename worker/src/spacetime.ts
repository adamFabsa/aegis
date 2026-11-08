import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Identity } from 'spacetimedb';
import { config } from './config';
import { errMsg, log } from './log';
import { DbConnection } from './module_bindings';

export function readWorkerToken(): string | undefined {
  if (!existsSync(config.tokenFile)) return undefined;
  const t = readFileSync(config.tokenFile, 'utf8').trim();
  return t || undefined;
}

export function saveWorkerToken(token: string) {
  if (readWorkerToken() === token) return;
  writeFileSync(config.tokenFile, token + '\n', { mode: 0o600 });
  try {
    chmodSync(config.tokenFile, 0o600);
  } catch {
    /* Windows: best effort */
  }
  log.info('saved worker token', { file: config.tokenFile });
}

export interface Opened {
  conn: DbConnection;
  identity: Identity;
  token: string;
}

/** One-shot connect (used by the register script). The long-running worker uses connectForever in index.ts. */
export function openConnection(token: string | undefined, timeoutMs = 15000): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.disconnect();
      reject(new Error(`SpacetimeDB connection to ${config.server} timed out`));
    }, timeoutMs);
    const conn: DbConnection = DbConnection.builder()
      .withUri(config.server)
      .withDatabaseName(config.database)
      .withToken(token)
      .onConnect((c, identity, tok) => {
        clearTimeout(timer);
        resolve({ conn: c, identity, token: tok });
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timer);
        reject(new Error(`SpacetimeDB connect error: ${errMsg(error)}`));
      })
      .build();
  });
}
