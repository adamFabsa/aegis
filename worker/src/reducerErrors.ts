import { errMsg } from './log';

export class NotConnectedError extends Error {
  constructor() {
    super('not connected to SpacetimeDB');
  }
}

/**
 * How to react to a rejected reducer call:
 *  - auth:      the worker identity isn't registered → keep the result, retry after `npm run register`
 *  - permanent: the world moved on (reply no longer pending, phase changed, row gone) → drop it
 *  - transient: connection issue → retry later
 */
export function reducerFailure(e: unknown): 'auth' | 'permanent' | 'transient' {
  if (e instanceof NotConnectedError) return 'transient';
  const m = errMsg(e);
  if (/worker only/i.test(m)) return 'auth';
  if (/no pending text reply|cannot reply|fire phase required|not found|already safe|invalid check-in|not initialized|exceeds/i.test(m))
    return 'permanent';
  return 'transient';
}
