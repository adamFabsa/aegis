import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './config';
import { generateJson, geminiErr } from './gemini';
import { errMsg, log } from './log';
import { reducerFailure } from './reducerErrors';
import type { WorkerState } from './state';
import type { Building, Fix } from './module_bindings/types';

// ───────────── seed: construction features + A's template note (the building table has neither) ─────────────

interface SeedBuilding {
  id: number;
  explanation?: string;
  referenceFireEtaMin?: number;
  features?: Record<string, string | number>;
}
const seed = new Map<number, SeedBuilding>();
function loadSeed() {
  if (!existsSync(config.seedBuildings)) {
    log.warn('seed buildings file not found; explanations will use table fields only', { file: config.seedBuildings });
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(config.seedBuildings, 'utf8')) as { buildings?: SeedBuilding[] } | SeedBuilding[];
    for (const b of Array.isArray(raw) ? raw : raw.buildings ?? []) seed.set(b.id, b);
    log.info('loaded seed building features', { count: seed.size, file: config.seedBuildings });
  } catch (e) {
    log.warn('could not parse seed buildings', { error: errMsg(e) });
  }
}
loadSeed();

// ───────────── facts (all words — numbers stay in code) ─────────────

const KIND: Record<string, string> = {
  senior: 'senior-living building',
  apartments: 'apartment building',
  office: 'office building',
  homes: 'row of single-family homes',
  shelter: 'evacuation shelter',
};

function riskBand(risk: number): string {
  if (risk >= 70) return 'very high';
  if (risk >= 50) return 'high';
  if (risk >= 30) return 'moderate';
  return 'low';
}

function era(year: unknown): string | undefined {
  if (typeof year !== 'number' || !year) return undefined;
  if (year < 1990) return 'older construction, built long before current wildfire building codes';
  if (year < 2008) return 'built before current wildfire building codes';
  return 'built to current wildfire building codes';
}

function describeFeature(key: string, value: string | number): string | undefined {
  if (key === 'yearBuilt' || key === 'floors') return undefined;
  const v = String(value);
  if (key === 'vents') {
    if (v.includes('>')) return 'coarse mesh vent screens that let embers through';
    if (v.includes('<=')) return 'fine ember-resistant mesh vent screens';
  }
  const clean = v.replace(/\d/g, '').replace(/\s+/g, ' ').trim();
  return clean ? clean : undefined;
}

/** The model's top drivers, from A's template ("driven by roof: wood/combustible, vents: coarse mesh (>1/8in), …"). */
function modelDrivers(template: string | undefined, features: SeedBuilding['features']): string[] {
  const m = template?.match(/driven by (.+?)\.\s/);
  if (!m) return [];
  return m[1]
    .split(/,\s*/)
    .map((d) => (/^year built/i.test(d) ? `age: ${era(features?.yearBuilt) ?? 'older construction'}` : d.replace(/\s*\([^)]*\)/g, '').trim()))
    .filter((d) => d && !/\d/.test(d));
}

interface Facts {
  buildingType: string;
  riskLevel: string;
  modelTopRiskDrivers: string[];
  construction: Record<string, string>;
  age?: string;
  hasResidentsWhoNeedHelpMoving: boolean;
  evacuationSlowerThanFire?: boolean;
  fixesRankedByModel: Array<{ name: string; effect: string; alreadyApproved: boolean }>;
}

export function buildFacts(b: Building, fixes: Fix[]): Facts {
  const s = seed.get(b.id);
  const construction: Record<string, string> = {};
  for (const [k, v] of Object.entries(s?.features ?? {})) {
    const d = describeFeature(k, v);
    if (d) construction[k] = d;
  }
  const eta = b.fireEtaMin > 0 ? b.fireEtaMin : s?.referenceFireEtaMin;
  const ranked = [...fixes]
    .filter((f) => f.riskDrop > 0 || f.addVans > 0)
    .sort((a, z) => z.riskDrop - a.riskDrop)
    .map((f, i) => ({
      name: f.name,
      effect: f.addVans > 0 && f.riskDrop <= 0 ? 'speeds up evacuation (does not change ignition risk)' : i === 0 ? 'largest drop in ignition risk' : 'lowers ignition risk',
      alreadyApproved: f.approved,
    }));
  return {
    buildingType: KIND[b.kind] ?? b.kind.replace(/\d/g, ''),
    riskLevel: riskBand(b.risk),
    modelTopRiskDrivers: modelDrivers(s?.explanation, s?.features),
    construction,
    age: era(s?.features?.yearBuilt),
    hasResidentsWhoNeedHelpMoving: b.needsHelp > 0,
    evacuationSlowerThanFire: typeof eta === 'number' && eta > 0 && b.evacNeededMin > 0 ? b.evacNeededMin > eta : undefined,
    fixesRankedByModel: ranked,
  };
}

// ───────────── Gemini ─────────────

const SYSTEM = `You write the short risk note a property manager reads on a wildfire-preparedness dashboard.
Write exactly two plain sentences, together under 60 words:
1) Why this building is at risk, using only the given risk level, model risk drivers, construction and occupant facts.
2) What to fix first, naming fixes only from fixesRankedByModel (prefer ones not already approved, in the given order; mention evacuation speed if evacuationSlowerThanFire is true).
Hard rules: never write any number, digit, percentage, dollar amount, time or date — except inside a fix name copied verbatim. Say "this building", never a name or number. Do not invent facts that aren't given. No markdown, no lists.`;

const SCHEMA = {
  type: 'object',
  properties: { note: { type: 'string', description: 'Exactly two sentences, no numbers.' } },
  required: ['note'],
} as const;

/** Reject anything carrying a number Gemini made up. Digits may only appear inside code-provided fix names. */
export function validateNote(note: string, fixNames: string[]): string | undefined {
  const text = note.replace(/\s+/g, ' ').trim();
  if (!text) return 'empty note';
  if (text.length > 450) return 'note too long';
  let stripped = text;
  for (const n of fixNames) stripped = stripped.split(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ');
  if (/\d/.test(stripped) || /[%$]|\b(percent|dollars?|dozens?|hundreds?|thousands?|millions?|billions?)\b/i.test(stripped))
    return 'note contains numbers';
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length < 1 || sentences.length > 3) return `expected two sentences, got ${sentences.length}`;
  return undefined;
}

export async function writeNote(b: Building, facts: Facts): Promise<string | undefined> {
  const fixNames = facts.fixesRankedByModel.map((f) => f.name);
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await generateJson<{ note?: string }>({
      label: `explain#${b.id}`,
      system: SYSTEM,
      prompt: JSON.stringify(facts) + feedback,
      schema: SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.3,
    });
    const note = String(out.note ?? '').replace(/\s+/g, ' ').trim();
    const problem = validateNote(note, fixNames);
    if (!problem) return note;
    log.warn('gemini note rejected', { buildingId: b.id, attempt, problem, note });
    feedback = `\n\nYour previous note was rejected (${problem}). Rewrite it following every rule.`;
  }
  return undefined;
}

// ───────────── writer ─────────────

export interface ExplainDeps {
  building(id: number): Building | undefined;
  fixes(buildingId: number): Fix[];
  setExplanation(buildingId: number, text: string): Promise<void>;
  onAuthFailure(): void;
}

export class ExplanationWriter {
  private queue = new Set<number>();
  private pumping = false;

  constructor(private readonly state: WorkerState, private readonly deps: ExplainDeps) {}

  /** Empty, or still A's seed template (seed/reset restore it) → Gemini should write it. */
  needsNote(b: Building): boolean {
    if (b.kind === 'shelter') return false;
    const text = b.explanation.trim();
    return !text || text === seed.get(b.id)?.explanation?.trim();
  }

  observe(b: Building) {
    if (!this.needsNote(b)) return;
    this.queue.add(b.id);
    void this.pump();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.size) {
        const id = this.queue.values().next().value as number;
        this.queue.delete(id);
        await this.handle(id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async handle(id: number) {
    const b = this.deps.building(id);
    if (!b || !this.needsNote(b)) return;
    const facts = buildFacts(b, this.deps.fixes(id));
    const hash = createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 20);
    let text = this.state.explanation(id)?.hash === hash ? this.state.explanation(id)!.text : undefined;
    if (text) {
      log.info('reusing cached note (same facts)', { buildingId: id });
    } else {
      log.info('writing building note', { buildingId: id, name: b.name, riskLevel: facts.riskLevel });
      try {
        text = await writeNote(b, facts);
      } catch (e) {
        log.error('gemini explanation failed; keeping current text', { buildingId: id, error: geminiErr(e) });
        return;
      }
      if (!text) {
        log.warn('no valid note after retries; keeping current text', { buildingId: id });
        return;
      }
      this.state.setExplanation(id, { hash, text });
    }
    const now = this.deps.building(id);
    if (!now || !this.needsNote(now)) return; // someone else filled it meanwhile
    try {
      await this.deps.setExplanation(id, text);
      log.info('set_explanation ok', { buildingId: id, text });
    } catch (e) {
      const kind = reducerFailure(e);
      if (kind === 'auth') this.deps.onAuthFailure();
      else log.warn('set_explanation failed', { buildingId: id, kind, error: errMsg(e) });
    }
  }
}
