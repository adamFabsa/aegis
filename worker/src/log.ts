import { config } from './config';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(config.logLevel as Level)] ?? LEVELS.info;

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const extra = data && Object.keys(data).length ? ' ' + JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : '';
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line + extra);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
