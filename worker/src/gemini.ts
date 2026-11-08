import { GoogleGenAI } from '@google/genai';
import { claudeJson } from './claude';
import { config } from './config';
import { errMsg, log } from './log';

/** The model provider the worker talks to (AI_PROVIDER), for logs and startup checks. */
export const providerName = () => (config.provider === 'claude' ? `Claude (${config.claudeModel})` : `Gemini (${config.geminiModel})`);
/** Missing credentials for the chosen provider, or undefined when ready. */
export function missingKey(): string | undefined {
  if (config.provider === 'claude') return process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() ? undefined : 'ANTHROPIC_API_KEY';
  return config.geminiApiKey ? undefined : 'GEMINI_API_KEY';
}

let client: GoogleGenAI | undefined;
function ai(): GoogleGenAI {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set (worker/.env)');
  return (client ??= new GoogleGenAI({ apiKey: config.geminiApiKey }));
}

// ── scheduler: priority queue + concurrency cap + client-side RPM pacing + global 429 pause ──
// Resident replies (priority 0) always go before building notes (priority 1): a rescue beats a blurb.

interface Job {
  priority: number;
  seq: number;
  start: () => void;
}
const queue: Job[] = [];
let seq = 0;
let active = 0;
let lastStart = 0;
let pausedUntil = 0;
let pumpTimer: NodeJS.Timeout | undefined;
const minGapMs = () => Math.ceil(60_000 / (config.provider === 'claude' ? config.claudeRpm : config.geminiRpm));
const maxActive = () => (config.provider === 'claude' ? config.claudeConcurrency : config.geminiConcurrency);

function pump() {
  clearTimeout(pumpTimer);
  pumpTimer = undefined;
  while (queue.length && active < maxActive()) {
    const wait = Math.max(pausedUntil, lastStart + minGapMs()) - Date.now();
    if (wait > 0) {
      pumpTimer = setTimeout(pump, wait);
      return;
    }
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const job = queue.shift()!;
    active++;
    lastStart = Date.now();
    job.start();
  }
}

function schedule<T>(priority: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      seq: seq++,
      start: () =>
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          }),
    });
    pump();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── model selection: primary, then fallback while the primary's daily quota is exhausted ──
const exhaustedUntil = new Map<string, number>();
function pickModel(): string | undefined {
  if (config.provider === 'claude') return config.claudeModel;
  const models = [config.geminiModel, config.geminiFallbackModel].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
  return models.find((m) => (exhaustedUntil.get(m) ?? 0) <= Date.now());
}

function status(e: unknown): number | undefined {
  const s = (e as { status?: number })?.status;
  if (typeof s === 'number') return s;
  const m = errMsg(e).match(/"code":\s*(\d{3})/);
  return m ? Number(m[1]) : undefined;
}

/** Server-suggested wait ("Please retry in 41.2s" / RetryInfo "retryDelay":"41s"), in ms. */
function retryAfterMs(e: unknown): number | undefined {
  const m = errMsg(e).match(/retry in ([\d.]+)\s*s|"retryDelay":\s*"([\d.]+)s"/i);
  const s = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(s) ? Math.ceil(s * 1000) + 250 : undefined;
}

function retryable(e: unknown): boolean {
  const s = status(e);
  if (s !== undefined) return s === 429 || s >= 500;
  return /rate|quota|unavailable|overloaded|timeout|ECONNRESET|ETIMEDOUT|fetch failed|connection error/i.test(errMsg(e));
}

/** Short message for logs (Gemini errors are long JSON blobs). */
export function geminiErr(e: unknown): string {
  const s = status(e);
  const m = errMsg(e).match(/"message":\s*"([^"]{0,160})/);
  return `${s ?? ''} ${m ? m[1] : errMsg(e).slice(0, 160)}`.trim();
}

/**
 * One structured-output Gemini call. `schema` is a JSON Schema; the response is parsed JSON.
 * Transient errors (429 / 5xx / network) are retried; a 429 pauses every queued call for the server's suggested delay.
 */
export async function generateJson<T>(opts: {
  label: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  temperature?: number;
  /** 0 = urgent (resident replies), 1 = background (building notes). */
  priority?: number;
}): Promise<T> {
  const maxAttempts = 6;
  for (let attempt = 1; ; attempt++) {
    const model = pickModel();
    if (!model) throw new Error('all Gemini models are out of quota (daily limit) — see worker logs');
    try {
      return await schedule(opts.priority ?? 1, async () => {
        const started = Date.now();
        if (config.provider === 'claude') {
          const out = await claudeJson<T>({ system: opts.system, prompt: opts.prompt, schema: opts.schema });
          log.debug(`claude ${opts.label} ok`, { ms: Date.now() - started, model: out.model });
          return out.data;
        }
        const res = await ai().models.generateContent({
          model,
          contents: opts.prompt,
          config: {
            systemInstruction: opts.system,
            temperature: opts.temperature ?? 0,
            responseMimeType: 'application/json',
            responseJsonSchema: opts.schema,
          },
        });
        const text = res.text;
        if (!text) throw new Error('empty Gemini response');
        log.debug(`gemini ${opts.label} ok`, { ms: Date.now() - started, model });
        return JSON.parse(text) as T;
      });
    } catch (e) {
      if (attempt >= maxAttempts || !retryable(e)) throw e;
      const suggested = retryAfterMs(e);
      // A long server delay means a daily quota, not a per-minute one: park this model and move on.
      if (status(e) === 429 && suggested !== undefined && suggested > 120_000) {
        exhaustedUntil.set(model, Date.now() + suggested);
        const next = pickModel();
        log.warn(`gemini model ${model} is out of daily quota for ~${Math.round(suggested / 60_000)} min`, {
          switchingTo: next ?? 'none',
        });
        if (!next) throw e;
        attempt--; // switching models is not a failed attempt
        continue;
      }
      const delay = Math.min(65_000, suggested ?? 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      if (status(e) === 429) pausedUntil = Math.max(pausedUntil, Date.now() + delay);
      log.warn(`gemini ${opts.label} failed, retrying in ${Math.round(delay / 1000)}s`, { attempt, error: geminiErr(e) });
      await sleep(delay);
    }
  }
}
