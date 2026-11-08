import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** worker/ — all relative paths below resolve against it, whatever the cwd. */
export const WORKER_DIR = fileURLToPath(new URL('..', import.meta.url));

function env(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

export const config = {
  server: env('SPACETIME_SERVER', 'https://maincloud.spacetimedb.com'),
  database: env('SPACETIME_DATABASE', 'lantern'),
  tokenFile: resolve(WORKER_DIR, env('WORKER_TOKEN_FILE', '.worker-token')),
  stateFile: resolve(WORKER_DIR, env('WORKER_STATE_FILE', '.worker-state.json')),
  seedBuildings: resolve(WORKER_DIR, env('SEED_BUILDINGS', '../seed/buildings.json')),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
  geminiModel: env('GEMINI_MODEL', 'gemini-3.6-flash'),
  // Used while the primary model's daily quota is exhausted (free tier: 20 requests/day/model). Set to '' to disable.
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() ?? 'gemini-3.5-flash-lite',
  geminiConcurrency: Math.max(1, Number(env('GEMINI_CONCURRENCY', '2')) || 2),
  // Client-side pacing. Free tier is ~5 requests/minute; raise on a paid key.
  geminiRpm: Math.max(1, Number(env('GEMINI_RPM', '5')) || 5),
  // Which model answers: 'gemini' (default) or 'claude'. Both make the same structured-JSON calls.
  provider: (env('AI_PROVIDER', 'gemini').toLowerCase() === 'claude' ? 'claude' : 'gemini') as 'claude' | 'gemini',
  claudeModel: env('CLAUDE_MODEL', 'claude-opus-5-5'),
  // Triage and two-sentence notes are short, well-specified tasks: low effort keeps replies fast.
  claudeEffort: env('CLAUDE_EFFORT', 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  claudeConcurrency: Math.max(1, Number(env('CLAUDE_CONCURRENCY', '4')) || 4),
  claudeRpm: Math.max(1, Number(env('CLAUDE_RPM', '50')) || 50),
  logLevel: env('LOG_LEVEL', 'info'),
};
