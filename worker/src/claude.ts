// Claude provider for the worker (AI_PROVIDER=claude): the same structured-JSON calls the Gemini path makes —
// resident reply triage and building notes — through the Anthropic SDK's structured outputs.
// Credentials: ANTHROPIC_API_KEY in worker/.env (the SDK reads it from the environment).
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  return (client ??= new Anthropic());
}

/**
 * Structured outputs take standard JSON Schema with closed objects: drop Gemini-only keywords
 * (propertyOrdering) and add additionalProperties: false to every object.
 */
export function claudeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(claudeSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === 'propertyOrdering') continue;
    out[k] = k === 'properties' && v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, claudeSchema(pv)]))
      : claudeSchema(v);
  }
  if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

/**
 * One structured-output Claude call; returns the parsed JSON and the model that answered.
 * Server-side refusal fallbacks are on ("default"), so a declined request is re-run on a fallback model
 * inside the same call; a refusal that survives the whole chain is thrown as an error.
 */
export async function claudeJson<T>(opts: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<{ data: T; model: string }> {
  const res = await anthropic().beta.messages.create({
    model: config.claudeModel,
    max_tokens: 4000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
    output_config: {
      effort: config.claudeEffort,
      format: { type: 'json_schema', schema: claudeSchema(opts.schema) as Record<string, unknown> },
    },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined the request (${res.stop_details?.category ?? 'refusal'})`);
  if (res.stop_reason === 'max_tokens') throw new Error('Claude response hit max_tokens');
  let text = '';
  for (const block of res.content) if (block.type === 'text') text += block.text;
  if (!text.trim()) throw new Error('empty Claude response');
  return { data: JSON.parse(text) as T, model: res.model };
}
