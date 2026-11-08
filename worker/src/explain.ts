import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './config';
import { generateJson, geminiErr } from './gemini';
import { errMsg, log } from './log';
import { reducerFailure } from './reducerErrors';
import type { WorkerState } from './state';
import type { Building, BuildingProfile, Fix } from './module_bindings/types';

// ───────────── seed file: fallback only, for a module without building_profile rows ─────────────

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

// ───────────── the module's template notes (seed, reset and every new scenario write one) ─────────────

/** "Risk 64 if an Eaton-like fire reaches it — driven by …. Biggest single fix: Class A roof (−20)." */
const RISK_TEMPLATE = /^Risk \d+(?:\.\d+)? if an? [^.]*fire reaches it\b/;
/** "Shelter A is the evacuation destination. Model risk 38." */
const SHELTER_TEMPLATE = /\bis the evacuation destination\. Model risk \d+(?:\.\d+)?\.?$/;

/** A note the module wrote from its model (seed / reset / new scenario), not one the worker wrote (those have no digits). */
export function isTemplate(text: string): boolean {
  const t = text.trim();
  return RISK_TEMPLATE.test(t) || SHELTER_TEMPLATE.test(t);
}

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

/**
 * Plain words for a construction feature, in the risk model's vocabulary ('Wood/Combustible', 'Coarse mesh (>1/8in)',
 * 'Stucco/Brick/Cement', …) and the pipeline seed's older one ('Wood', 'Mesh Screen > 1/8"', 'Stucco Brick Cement').
 * Matched on the lower-cased value; first match wins, so the more specific pattern comes first.
 */
const PHRASES: Record<string, Array<[RegExp, string]>> = {
  roof: [
    [/wood|combustible|shake/, 'combustible wood roof'],
    [/fire.?resist|class a/, 'fire-resistant roof'],
    [/asphalt|composition/, 'asphalt shingle roof'],
    [/tile|concrete|clay/, 'tile or concrete roof'],
    [/metal/, 'metal roof'],
  ],
  vents: [
    [/unscreened|no screen/, 'unscreened vents that let embers in'],
    [/no vents?\b/, 'no exterior vents'],
    [/>|coarse/, 'coarse mesh vent screens that let embers through'],
    [/<|fine|ember/, 'fine ember-resistant mesh vent screens'],
    [/screen|mesh/, 'screened vents of unknown mesh size'],
  ],
  eaves: [
    [/unenclosed|open|exposed/, 'open eaves that can trap embers'],
    [/no eaves/, 'no eaves'],
    [/enclosed|boxed/, 'enclosed eaves'],
  ],
  siding: [
    [/wood|combustible|vinyl/, 'combustible wood siding'],
    [/ignition|resist/, 'ignition-resistant siding'],
    [/stucco|brick|cement|masonry/, 'stucco, brick or cement siding'],
    [/metal/, 'metal siding'],
  ],
  windows: [
    [/single/, 'single-pane windows that can break in the heat'],
    [/multi|double|dual|tempered/, 'multi-pane windows'],
  ],
};

/** Words only: sizes, units and other digits never reach the facts (notes are rejected if they carry numbers). */
function words(v: string): string {
  return v
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\d"<>=+]/g, ' ')
    .replace(/\s*\/\s*/g, ' or ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function describeFeature(key: string, value: string | number): string | undefined {
  if (key === 'yearBuilt' || key === 'floors' || typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (!v || v === 'unknown') return undefined;
  for (const [re, phrase] of PHRASES[key] ?? []) if (re.test(v)) return phrase;
  return words(v) || undefined;
}

const PROFILE_FEATURES = ['roof', 'vents', 'eaves', 'windows', 'siding'] as const;

/**
 * The model's top drivers from the module's template ("driven by roof: wood/combustible, vents: coarse mesh (>1/8in),
 * year built: 1960-1989."), in plain words: ['combustible wood roof', 'coarse mesh vent screens …', 'age: older …'].
 */
function modelDrivers(template: string | undefined, yearBuilt: number | undefined): string[] {
  const m = template?.match(/driven by (.+?)\.(?:\s|$)/);
  if (!m) return [];
  return m[1]
    .split(/,\s*/)
    .map((d) => {
      const [, key = '', value = ''] = d.match(/^\s*([^:]+):\s*(.*)$/) ?? [];
      const k = key.trim().toLowerCase();
      if (k === 'year built') return `age: ${era(yearBuilt) ?? era(Number(value.match(/\d{4}/)?.[0])) ?? 'older construction'}`;
      return (k && describeFeature(k, value)) || words(d);
    })
    .filter((d) => d && !/\d/.test(d));
}

export interface Facts {
  buildingType: string;
  riskLevel: string;
  modelTopRiskDrivers: string[];
  construction: Record<string, string>;
  age?: string;
  hasResidentsWhoNeedHelpMoving: boolean;
  evacuationSlowerThanFire?: boolean;
  fixesRankedByModel: Array<{ name: string; effect: string; alreadyApproved: boolean }>;
}

/**
 * Word-only facts for one building, from the live database: construction and age from its building_profile row
 * (rewritten by every new scenario), the model's drivers from its template note, risk, residents and fixes from the
 * building and fix rows. The seed file is used only when there is no profile row (a module without that table).
 * `template`: the module's template for this building (defaults to the row's text; ignored unless it is one).
 */
export function buildFacts(b: Building, fixes: Fix[], profile?: BuildingProfile, template: string = b.explanation): Facts {
  const s = profile ? undefined : seed.get(b.id);
  const features: Record<string, string | number> = profile
    ? Object.fromEntries(PROFILE_FEATURES.map((k) => [k, profile[k]]))
    : { ...(s?.features ?? {}) };
  const construction: Record<string, string> = {};
  for (const [k, v] of Object.entries(features)) {
    const d = describeFeature(k, v);
    if (d) construction[k] = d;
  }
  const seedYear = s?.features?.yearBuilt;
  const yearBuilt = profile ? profile.yearBuilt || undefined : typeof seedYear === 'number' ? seedYear : undefined;
  const driversFrom = isTemplate(template) ? template : s?.explanation;
  // At seed the module puts the scenario's reference fire arrival in fireEtaMin (−1 = not expected to reach it).
  const eta = b.fireEtaMin > 0 ? b.fireEtaMin : s?.referenceFireEtaMin;
  const ranked = [...fixes]
    .filter((f) => f.riskDrop > 0 || f.addVans > 0)
    .sort((a, z) => z.riskDrop - a.riskDrop || a.id - z.id)
    .map((f, i) => ({
      name: f.name,
      effect: f.addVans > 0 && f.riskDrop <= 0 ? 'speeds up evacuation (does not change ignition risk)' : i === 0 ? 'largest drop in ignition risk' : 'lowers ignition risk',
      alreadyApproved: f.approved,
    }));
  return {
    buildingType: KIND[b.kind] ?? (words(b.kind) || 'building'),
    riskLevel: riskBand(b.risk),
    modelTopRiskDrivers: modelDrivers(driversFrom, yearBuilt),
    construction,
    age: era(yearBuilt),
    hasResidentsWhoNeedHelpMoving: b.needsHelp > 0,
    evacuationSlowerThanFire: typeof eta === 'number' && eta > 0 && b.evacNeededMin > 0 ? b.evacNeededMin > eta : undefined,
    fixesRankedByModel: ranked,
  };
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 20);
/** Cache key: exactly the facts a note is written from. */
export const factsHash = (f: Facts): string => sha(f);
/**
 * Which world the facts describe: what a new scenario rebuilds (construction, age, residents, the fix list) and a run
 * never changes. Approving a fix or the fire getting closer keeps the basis; a new scenario changes it.
 */
export const factsBasis = (f: Facts): string =>
  sha([f.buildingType, f.construction, f.age ?? '', f.hasResidentsWhoNeedHelpMoving, f.fixesRankedByModel.map((x) => x.name).sort()]);

// ───────────── Gemini ─────────────

const SYSTEM = `You are Aegis's AI coach. You write the short instruction a property manager reads on their phone to save one building before a wildfire, which also lowers the insurer's expected claim.
Write exactly two plain sentences, together under 55 words:
1) An instruction in the imperative: what to do first to save this building, naming one or two fixes copied verbatim from fixesRankedByModel (skip any with alreadyApproved true, keep the given order; if evacuationSlowerThanFire is true and an evacuation fix exists, put getting residents out first).
2) Why, in plain words: the main risk drivers from modelTopRiskDrivers / construction / age, and that the fix keeps residents safe and cuts the expected insurance claim.
If riskLevel is "low", do not call the building at risk: say it is in good shape and name at most one fix as cheap upkeep. If every fix is already approved, say the planned fixes cover the main risks and to keep the ember-resistant zone clear.
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
  /** The building's building_profile row: its construction in the current scenario. */
  profile(buildingId: number): BuildingProfile | undefined;
  setExplanation(buildingId: number, text: string): Promise<void>;
  onAuthFailure(): void;
  /** Writes a note from facts; defaults to the AI provider (tests pass a stub). */
  writeNote?(b: Building, facts: Facts): Promise<string | undefined>;
}

const profileKey = (p: BuildingProfile | undefined) => (p ? [p.roof, p.vents, p.eaves, p.windows, p.siding, p.yearBuilt].join('|') : '');

export class ExplanationWriter {
  private queue = new Set<number>();
  private pumping = false;
  /** The last module template seen per building (with the construction it describes): the model's drivers, once a note replaced it. */
  private templates = new Map<number, { text: string; profile: string }>();

  constructor(private readonly state: WorkerState, private readonly deps: ExplainDeps) {}

  /** Facts for the building as the database has it now. */
  facts(b: Building): Facts {
    const profile = this.deps.profile(b.id);
    const kept = this.templates.get(b.id);
    const template = isTemplate(b.explanation) ? b.explanation : kept && kept.profile === profileKey(profile) ? kept.text : undefined;
    return buildFacts(b, this.deps.fixes(b.id), profile, template);
  }

  /**
   * Write a note when the text is empty or still one of the module's templates (seed, reset and every new scenario
   * write one), or when it is a note this worker sent about a different world (one that landed just after a new scenario).
   */
  needsNote(b: Building): boolean {
    if (b.kind === 'shelter') return false;
    const text = b.explanation.trim();
    if (!text || isTemplate(text) || text === seed.get(b.id)?.explanation?.trim()) return true;
    const sent = this.state.explanation(b.id);
    return !!sent?.basis && sent.text === text && sent.basis !== factsBasis(this.facts(b));
  }

  /** A building or its building_profile row changed (new scenario, reset, fix, fire): queue it if it needs a note. */
  observe(b: Building) {
    if (isTemplate(b.explanation)) this.templates.set(b.id, { text: b.explanation.trim(), profile: profileKey(this.deps.profile(b.id)) });
    if (!this.needsNote(b)) return;
    this.queue.add(b.id);
    void this.pump();
  }

  /** Resolves once every queued building has been handled (tests). */
  async idle(): Promise<void> {
    while (this.pumping || this.queue.size) await new Promise((r) => setTimeout(r, 5));
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
    const facts = this.facts(b);
    const hash = factsHash(facts);
    let text = this.state.note(hash);
    if (text) {
      log.info('reusing cached note (same facts)', { buildingId: id });
    } else {
      log.info('writing building note', { buildingId: id, name: b.name, riskLevel: facts.riskLevel });
      try {
        text = await (this.deps.writeNote ?? writeNote)(b, facts);
      } catch (e) {
        log.error('gemini explanation failed; keeping current text', { buildingId: id, error: geminiErr(e) });
        return;
      }
      if (!text) {
        log.warn('no valid note after retries; keeping current text', { buildingId: id });
        return;
      }
      this.state.setNote(hash, text); // still right for these facts, even if the world moved on meanwhile
    }
    const now = this.deps.building(id);
    if (!now || !this.needsNote(now)) return; // someone else filled it meanwhile
    // A new scenario, reset or approved fix while the model was writing: this note is for facts the building no
    // longer has. Drop it and write one for the current facts instead.
    if (factsHash(this.facts(now)) !== hash) {
      log.info('facts changed while the note was being written; not writing the stale note', { buildingId: id });
      this.queue.add(id);
      return;
    }
    this.state.setExplanation(id, { hash, text, basis: factsBasis(facts) });
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
