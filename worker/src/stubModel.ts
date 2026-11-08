/**
 * A stand-in for the Claude Messages API, for tests without a key or quota. `E2E_STUB_MODEL=1 npm run e2e` points the
 * worker at it (AI_PROVIDER=claude + ANTHROPIC_BASE_URL). Building notes are composed from the facts the worker sends;
 * replies are triaged by keywords. Test-only: the worker never starts it.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubRequest {
  kind: 'note' | 'triage';
  input: Record<string, unknown>;
}
export interface StubModel {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

function triage(reply: string): { category: string; reason: string } {
  const t = reply.toLowerCase();
  if (/oxygen|breath|chest|bleed|burn|faint|inhal|injur/.test(t)) return { category: 'needs_medical', reason: 'stub: medical words' };
  if (/wheelchair|walker|can'?t|cannot|stuck|trapped|blocked/.test(t)) return { category: 'cant_move', reason: 'stub: cannot get out' };
  if (/\b(safe|shelter|fine|outside|left)\b/.test(t)) return { category: 'safe', reason: 'stub: says safe' };
  return { category: 'unclear', reason: 'stub: no keyword' };
}

interface NoteFacts {
  modelTopRiskDrivers?: string[];
  construction?: Record<string, string>;
  fixesRankedByModel?: Array<{ name: string; alreadyApproved: boolean }>;
}
function note(f: NoteFacts): string {
  const fix = f.fixesRankedByModel?.find((x) => !x.alreadyApproved)?.name;
  const why = (f.modelTopRiskDrivers?.[0] ?? Object.values(f.construction ?? {})[0] ?? 'its construction').replace(/^age:\s*/, '');
  const first = fix ? `Approve ${fix} first for this building.` : 'Keep the ember-resistant zone clear around this building.';
  return `${first} The main risk is ${why}, and acting now keeps residents safe and cuts the expected insurance claim.`;
}

export async function startStubModel(delayMs = 600): Promise<StubModel> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      let out: unknown;
      try {
        const msg = JSON.parse(body) as { system?: string; messages?: Array<{ content: string }> };
        const input = JSON.parse(String(msg.messages?.[0]?.content ?? '{}').split('\n\n')[0]) as Record<string, unknown>;
        const kind = /triage/i.test(msg.system ?? '') ? 'triage' : 'note';
        requests.push({ kind, input });
        out = kind === 'triage' ? triage(String(input.reply ?? '')) : { note: note(input as NoteFacts) };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: String(e) } }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: `msg_stub_${requests.length}`,
            type: 'message',
            role: 'assistant',
            model: 'stub-model',
            content: [{ type: 'text', text: JSON.stringify(out) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
