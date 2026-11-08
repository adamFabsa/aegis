// Aegis AI: the step-by-step instructions on the phone.
//   Before the fire  — what to fix, ranked like the server's approve_recommended (people first, then expected
//                      claims avoided per dollar), so "Approve the plan" does exactly what the list says.
//   During the fire  — State Farm's question: who has the most urgent need, how to coordinate help, and that
//                      no one is overlooked; plus when to evacuate and where to send engines ahead of the fire.
// Every number comes from the shared simulation (the CAL FIRE risk model + the calibrated fire); Gemini writes
// the per-building notes and reads residents' free-text replies (the worker).
import type { Building, Person, ScenarioResult, Sim, Task } from '../town/types';
import type { Unit } from '../town/mockWorld';
import type { BuildingProfile, FixView, Measure } from '../town/world';
import { fixAvoids, portfolio } from './impact';
import { fmtMin, fmtUsd } from './format';

export type Tone = 'now' | 'soon' | 'plan' | 'good' | 'info';
export type Action =
  | { kind: 'approve'; buildingId: number; fixKey: string; label: string }
  | { kind: 'plan'; label: string }
  | { kind: 'evacuate'; buildingId: number; label: string }
  | { kind: 'dispatch'; buildingId: number; label: string }
  /** one or more help tasks (a building's waiting residents go out as one card): assign_staff per task */
  | { kind: 'assign'; taskIds: number[]; buildingId: number; label: string }
  | { kind: 'select'; buildingId: number; label: string };

export interface Instruction {
  id: string;
  tone: Tone;
  title: string;
  why: string;
  /** impact chips */
  people?: number;
  usd?: number;
  /** the resident's own words, when the instruction comes from a reply the AI read */
  quote?: string;
  buildingId?: number;
  action?: Action;
}

export interface Advice {
  phase: Sim['phase'];
  headline: string;
  detail: string;
  stats: { label: string; value: string; tone?: 'ok' | 'bad' }[];
  items: Instruction[];
  /** "Approve the plan": the whole prep plan in one go (server-side approve_recommended) */
  plan?: { count: number; cost: number };
  /** Gemini's note on the building the advice is about (worker-written) */
  note?: { building: string; text: string };
}

export interface AdvisorInput {
  sim: Sim;
  buildings: Building[];
  persons: Person[];
  tasks: Task[];
  units: Unit[];
  fixesFor: (buildingId: number) => FixView[];
  profileFor?: (buildingId: number) => BuildingProfile | undefined;
  checklistFor?: (buildingId: number) => Measure[];
  results?: { with: ScenarioResult; without: ScenarioResult };
  selectedId?: number | null;
  /** live: the coach can send on-site staff itself (assign_staff); otherwise it points at the building */
  canAssign?: boolean;
}

const MIN_RISK = 5;
/**
 * One headcount for every screen (coach, panel, card). Of the residents told to leave (their building's evacuation
 * started), "accounted for" are the ones out or confirmed safe; everyone else told to leave is unaccounted,
 * including the ones staff are on their way to.
 */
export function headcount(persons: Person[], buildings: Building[]) {
  const started = new Set(buildings.filter((b) => b.evacStarted).map((b) => b.id));
  const told = persons.filter((p) => started.has(p.buildingId));
  const isAccounted = (p: Person) => p.status === 'out' || p.status === 'safe';
  return { told, accounted: told.filter(isAccounted), unaccounted: told.filter((p) => !isAccounted(p)) };
}

/** The sim's wind direction is where it blows TOWARD; people name a wind by where it comes FROM. */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const windFrom = (towardDeg: number) => COMPASS[Math.round(((((towardDeg + 180) % 360) + 360) % 360) / 45) % 8];

/** an engine on scene before the fire arrives multiplies ignition odds by this (spacetimedb/src/sim.ts default) */
const ENGINE_PROTECT = 0.35;
const inside = (b: Building) => Math.max(0, b.residents - b.peopleOut);
const real = (b: Building) => b.kind !== 'shelter';

/** "Class A roof" → "Put a Class A roof on Building 12" */
function fixTitle(f: FixView, b: Building): string {
  if (f.addVans > 0) return `Add a second evacuation van at ${b.name}`;
  if (/roof/i.test(f.name)) return `Put a ${f.name} on ${b.name}`;
  if (/vent/i.test(f.name)) return `Fit ${f.name.toLowerCase()} at ${b.name}`;
  if (/brush/i.test(f.name)) return `${f.name} around ${b.name}`;
  return `${f.name} for ${b.name}`;
}

/** Evacuation time with more vans (staff × van bottleneck): an estimate for the sentence, not for the score. */
function evacWithVans(b: Building, add: number): number {
  if (b.evacNeededMin <= 0) return b.evacNeededMin;
  const vans = Math.max(1, b.vans);
  return b.evacNeededMin * (0.05 + 0.95 * (vans / (vans + add)));
}

interface Scored { f: FixView; b: Building; score: number; usd: number; people: number }

/** Mirror of spacetimedb/src/sim.ts recommendFixes (value per dollar, greedy within the budget). */
export function prepPlan(input: AdvisorInput, approved: (buildingId: number, key: string) => boolean): Scored[] {
  const scored: Scored[] = [];
  for (const b of input.buildings.filter(real)) {
    const profile = input.profileFor?.(b.id);
    for (const f of input.fixesFor(b.id)) {
      if (approved(b.id, f.key)) continue;
      const reach = b.fireEtaMin >= 0 ? 1 : 0.1;
      let value = (b.valueUsd * reach * f.riskDrop) / 100;
      let people = 0;
      if (f.addVans > 0 && b.fireEtaMin >= 0) {
        const before = b.evacNeededMin;
        const after = evacWithVans(b, f.addVans);
        if (before > b.fireEtaMin) {
          people = b.needsHelp;
          value += 1_000_000 * b.needsHelp * Math.min(1, (before - Math.max(after, b.fireEtaMin)) / Math.max(1, before - after));
        }
      }
      const score = value / Math.max(1, f.cost);
      if (score > 0) scored.push({ f, b, score, usd: fixAvoids(b, profile, f), people });
    }
  }
  scored.sort((a, c) => c.score - a.score);
  const out: Scored[] = [];
  let budget = input.sim.budgetLeft;
  for (const s of scored) {
    if (s.f.cost <= budget + 1e-6) {
      out.push(s);
      budget -= s.f.cost;
    }
  }
  return out;
}

function prepAdvice(input: AdvisorInput, approvedKeys: Record<number, string[]>): Advice {
  const { sim, buildings } = input;
  const plan = prepPlan(input, (id, key) => (approvedKeys[id] ?? []).includes(key));
  const loss = portfolio(buildings, input.profileFor);
  const atRisk = buildings.filter((b) => real(b) && b.fireEtaMin >= 0 && b.evacNeededMin > b.fireEtaMin);
  const peopleAtRisk = atRisk.reduce((n, b) => n + b.needsHelp, 0);
  const items: Instruction[] = plan.slice(0, 4).map(({ f, b, usd, people }) => {
    const measure = input.checklistFor?.(b.id).find((m) => String(m.fixId) === f.key && m.status !== 'met');
    let why: string;
    if (f.addVans > 0) {
      why = `${b.needsHelp} residents need help to get out. That takes ${fmtMin(b.evacNeededMin)}, and the fire is expected in ${fmtMin(b.fireEtaMin)}. With another van it takes about ${fmtMin(evacWithVans(b, f.addVans))}.`;
    } else {
      const to = Math.max(MIN_RISK, Math.round(b.risk - f.riskDrop));
      why = `Risk ${Math.round(b.risk)} → ${to}. Cuts the expected claim by ${fmtUsd(Math.round(usd))} for ${fmtUsd(f.cost)}${measure ? `, and documents “${measure.measure}” for the insurer` : ''}.`;
    }
    return {
      id: `fix-${b.id}-${f.key}`, tone: people > 0 ? 'now' : 'plan', title: fixTitle(f, b), why,
      people: people || undefined, usd: usd > 0 ? Math.round(usd) : undefined, buildingId: b.id,
      action: { kind: 'approve', buildingId: b.id, fixKey: f.key, label: `Approve · ${fmtUsd(f.cost)}` },
    };
  });
  const prepared = buildings.filter((b) => real(b) && b.prepared).length;
  const total = buildings.filter(real).length;
  if (!plan.length) {
    items.push({ id: 'prep-done', tone: 'good', title: prepared === total ? 'Every building is prepared' : 'Nothing else fits the budget', why: 'Start the fire to see how the neighborhood holds up against the same fire without Aegis.' });
  }
  const planUsd = plan.reduce((n, s) => n + s.usd, 0);
  const planPeople = plan.reduce((n, s) => n + s.people, 0);
  const planCost = plan.reduce((n, s) => n + s.f.cost, 0);
  const focus = buildings.find((b) => b.id === input.selectedId && real(b)) ?? (plan[0]?.b);
  return {
    phase: 'prep',
    headline: plan.length ? `Cut expected claims by ${fmtUsd(Math.round(planUsd))}` : 'Ready for the fire',
    detail: plan.length
      ? `${plan.length} fix${plan.length === 1 ? '' : 'es'} for ${fmtUsd(planCost)}${planPeople ? `, and ${planPeople} residents who need help get out before the fire` : ''}. Best value first.`
      : loss && loss.avoided > 0 ? `Prep avoids ${fmtUsd(Math.round(loss.avoided))} of expected claims.` : 'The budget is spent.',
    stats: [
      { label: 'budget', value: fmtUsd(sim.budgetLeft) },
      ...(loss ? [{ label: 'expected claims', value: fmtUsd(Math.round(loss.now)), tone: (loss.avoided > 0 ? 'ok' : undefined) as 'ok' | undefined }] : []),
      { label: 'residents at risk', value: String(peopleAtRisk), tone: peopleAtRisk ? 'bad' : 'ok' },
    ],
    items,
    plan: plan.length > 1 ? { count: plan.length, cost: planCost } : undefined,
    note: focus?.explanation ? { building: focus.name, text: focus.explanation } : undefined,
  };
}

function fireAdvice(input: AdvisorInput): Advice {
  const { sim, buildings, persons, tasks, units } = input;
  const byB = new Map(buildings.map((b) => [b.id, b]));
  const items: (Instruction & { rank: number })[] = [];
  const free = units.filter((u) => u.status === 'ready');
  const engineAt = (id: number) => units.find((u) => u.targetId === id && (u.status === 'enroute' || u.status === 'onscene'));
  const minsSince = (p: Person) => Math.max(0, (sim.tick - p.pingedAtTick) * Math.max(1, sim.minutesPerTick));

  // 1. People who need someone now: open help tasks nobody has claimed (urgent first, then oldest), one card per
  //    building, so three residents waiting in Building 12 are one "Send staff" press, not three cards.
  const open = tasks.filter((t) => !t.done && !t.claimedBy).sort((a, b) => b.priority - a.priority || a.createdTick - b.createdTick);
  const groups: { b: Building; list: { t: Task; p: Person }[] }[] = [];
  for (const t of open) {
    const p = persons.find((x) => x.id === t.personId);
    const b = byB.get(t.buildingId);
    if (!p || !b) continue;
    const g = groups.find((x) => x.b.id === b.id);
    if (g) g.list.push({ t, p });
    else groups.push({ b, list: [{ t, p }] });
  }
  for (const { b, list } of groups.slice(0, 3)) {
    const top = list[0].t;
    const canAssign = input.canAssign && b.status !== 'lost';
    if (list.length === 1) {
      const { t, p } = list[0];
      const silent = !p.replyText;
      items.push({
        id: `help-${t.id}`, rank: 0 - t.priority * 10, tone: 'now',
        title: `Send staff to ${p.name}${p.note ? ` (${p.note})` : ''}`,
        why: silent
          ? `${b.name}, floor ${p.floor}. No reply for ${fmtMin(minsSince(p))}, so Aegis escalated.`
          : `${b.name}, floor ${p.floor}. The AI read the reply as ${p.status === 'cant_move' ? 'cannot get out alone' : 'needs help'}.`,
        quote: silent ? undefined : p.replyText,
        people: 1, buildingId: b.id,
        action: canAssign ? { kind: 'assign', taskIds: [t.id], buildingId: b.id, label: 'Send staff' } : { kind: 'select', buildingId: b.id, label: 'Show' },
      });
      continue;
    }
    const floors = [...new Set(list.map(({ p }) => p.floor))].sort((x, y) => x - y);
    const silent = list.filter(({ p }) => !p.replyText).length;
    const names = list.slice(0, 3).map(({ p }) => `${p.name}${p.note ? ` (${p.note})` : ''}`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
    items.push({
      id: `help-b${b.id}`, rank: 0 - top.priority * 10, tone: 'now',
      title: `Send staff to ${list.length} residents in ${b.name}`,
      why: `${names}. Floor${floors.length === 1 ? '' : 's'} ${floors.join(', ')}${silent ? `; ${silent === list.length ? 'none' : `${list.length - silent} of them`} replied` : ''}.`,
      people: list.length, buildingId: b.id,
      action: canAssign ? { kind: 'assign', taskIds: list.map(({ t }) => t.id), buildingId: b.id, label: 'Send staff' } : { kind: 'select', buildingId: b.id, label: 'Show' },
    });
  }
  const more = groups.slice(3).reduce((n, g) => n + g.list.length, 0);
  if (more > 0) items.push({ id: 'help-more', rank: 1, tone: 'now', title: `${more} more ${more === 1 ? 'resident' : 'residents'} waiting for staff`, why: 'Staff see them on their phones, most urgent first.', people: more });

  // 2. Evacuate before the fire arrives.
  for (const b of buildings.filter(real)) {
    if (b.evacStarted || b.status === 'lost' || b.status === 'clear' || b.residents === 0) continue;
    const n = inside(b);
    if (b.status === 'burning') {
      items.push({ id: `evac-${b.id}`, rank: -100, tone: 'now', title: `Evacuate ${b.name} now`, why: `It is on fire with ${n} people inside.`, people: n, buildingId: b.id, action: { kind: 'evacuate', buildingId: b.id, label: 'Evacuate' } });
      continue;
    }
    if (b.fireEtaMin < 0) continue;
    const margin = b.fireEtaMin - b.evacNeededMin;
    if (margin < 20) {
      items.push({
        id: `evac-${b.id}`, rank: margin, tone: 'now', title: `Evacuate ${b.name} now`,
        why: b.fireEtaMin < 1
          ? `The fire is here, and getting ${n} people out takes ${fmtMin(b.evacNeededMin)}. Every minute counts.`
          : margin < 0
            ? `The fire arrives in ${fmtMin(b.fireEtaMin)}, but getting ${n} people out takes ${fmtMin(b.evacNeededMin)}. Every minute counts.`
            : `The fire arrives in ${fmtMin(b.fireEtaMin)}; getting ${n} people out takes ${fmtMin(b.evacNeededMin)}.`,
        people: n, buildingId: b.id, action: { kind: 'evacuate', buildingId: b.id, label: 'Evacuate' },
      });
    } else if (b.fireEtaMin < 150) {
      items.push({
        id: `evac-${b.id}`, rank: 50 + margin, tone: 'soon', title: `Get ${b.name} ready to leave`,
        why: `Fire in about ${fmtMin(b.fireEtaMin)}. Evacuation takes ${fmtMin(b.evacNeededMin)}, so start within ${fmtMin(margin)}.`,
        people: n, buildingId: b.id, action: { kind: 'evacuate', buildingId: b.id, label: 'Evacuate early' },
      });
    }
  }

  // 3. Buildings falling behind (already evacuating, fire faster than the evacuation).
  // (before its evacuation starts, the "Evacuate now" card above already covers a building that is behind)
  for (const b of buildings.filter((x) => real(x) && x.status === 'behind' && x.evacStarted)) {
    const n = inside(b);
    const canSend = free.length > 0 && !engineAt(b.id);
    items.push({
      id: `behind-${b.id}`, rank: -50 + Math.max(0, b.fireEtaMin), tone: 'now', title: `${b.name} is falling behind`,
      why: `${n} still inside and the fire is ${b.fireEtaMin >= 0 && b.fireEtaMin < 1 ? 'here' : b.fireEtaMin > 0 ? `${fmtMin(b.fireEtaMin)} away` : 'close'}. Staff from nearby buildings are being sent.${canSend ? ' An engine on scene buys time.' : ''}`,
      people: n, buildingId: b.id,
      action: canSend ? { kind: 'dispatch', buildingId: b.id, label: `Send ${free[0].name}` } : { kind: 'select', buildingId: b.id, label: 'Show' },
    });
  }

  // 4. Engines ahead of the fire: the next buildings it reaches, with people or value at stake.
  if (free.length) {
    const next = buildings
      .filter((b) => real(b) && b.status !== 'burning' && b.status !== 'lost' && b.status !== 'behind' && b.fireEtaMin >= 0 && b.fireEtaMin <= 60 && !engineAt(b.id))
      .sort((a, c) => a.fireEtaMin - c.fireEtaMin);
    for (const b of next.slice(0, Math.min(2, free.length))) {
      const profile = input.profileFor?.(b.id);
      const claim = profile ? (b.valueUsd * profile.reachProbability * b.risk) / 100 : 0;
      items.push({
        id: `engine-${b.id}`, rank: 20 + b.fireEtaMin, tone: b.fireEtaMin <= 25 ? 'now' : 'soon',
        title: `Send ${free[0].name} ahead of the fire to ${b.name}`,
        why: `Fire in about ${fmtMin(b.fireEtaMin)}. An engine on scene before it arrives cuts the chance the building ignites by ${Math.round((1 - ENGINE_PROTECT) * 100)}%.`,
        people: inside(b) || undefined, usd: claim ? Math.round(claim * (1 - ENGINE_PROTECT)) : undefined, buildingId: b.id,
        action: { kind: 'dispatch', buildingId: b.id, label: `Send ${free[0].name}` },
      });
    }
  }

  // 5. No one overlooked: residents who have not answered yet (Aegis escalates them automatically).
  const started = new Set(buildings.filter((b) => b.evacStarted).map((b) => b.id));
  const waiting = persons.filter((p) => started.has(p.buildingId) && p.status === 'pinged' && !p.replyText && !tasks.some((t) => t.personId === p.id && !t.done));
  if (waiting.length) {
    items.push({ id: 'waiting', rank: 200, tone: 'info', title: `${waiting.length} resident${waiting.length === 1 ? ' has' : 's have'} not answered yet`, why: 'If they stay silent, Aegis asks staff to check their floor. No one is left off the list.' });
  }
  const clear = buildings.filter((b) => real(b) && b.status === 'clear');
  if (clear.length) items.push({ id: 'clear', rank: 300, tone: 'good', title: `${clear.map((b) => b.name).join(', ')}: everyone out`, why: 'Accounted for at Shelter A.' });
  const onScene = units.filter((u) => u.status === 'onscene');
  if (onScene.length) {
    const spraying = onScene.filter((u) => byB.get(u.targetId ?? 0)?.status === 'burning').length;
    items.push({
      id: 'engines', rank: 310, tone: 'info', title: onScene.map((u) => `${u.name} at ${byB.get(u.targetId ?? 0)?.name ?? '…'}`).join(' · '),
      why: spraying === onScene.length ? 'Water on the burning buildings.' : spraying ? 'Water on the burning buildings; the others are standing by.' : 'Standing by: hoses go on if the building catches.',
    });
  }

  items.sort((a, c) => a.rank - c.rank);
  const { told, accounted, unaccounted } = headcount(persons, buildings);
  const rescues = tasks.filter((t) => !t.done && t.claimedBy).length;
  const needHelp = tasks.filter((t) => !t.done).length;
  const lost = persons.filter((p) => p.status === 'left_behind').length;
  const urgent = items.filter((i) => i.tone === 'now').length;
  const burning = buildings.filter((b) => real(b) && b.status === 'burning').length;
  const watching = buildings.filter((b) => real(b) && (b.status === 'burning' || b.status === 'behind')).length;
  const walking = unaccounted.filter((p) => p.status !== 'left_behind').length;
  // never "On track" while someone still needs help or a building is burning
  const [headline, detail] = urgent
    ? [`${urgent} thing${urgent === 1 ? '' : 's'} to do now`, 'Most urgent first. People before property.']
    : rescues
      ? [`Staff are on ${rescues} rescue${rescues === 1 ? '' : 's'}`, `Everyone who asked for help has someone on the way.${watching ? ` Aegis is watching ${watching} building${watching === 1 ? '' : 's'} in the fire.` : ''}`]
      : watching
        ? [`Watching ${watching} building${watching === 1 ? '' : 's'}`, burning ? `${burning} on fire. Engines and staff are on it; Aegis flags anything new.` : 'The fire is close. Aegis flags anything new.']
        : walking
          ? [`${walking} resident${walking === 1 ? '' : 's'} still on the way out`, 'Aegis checks each one in at Shelter A.']
          : lost
            ? [`${lost} resident${lost === 1 ? '' : 's'} left behind`, 'Firefighters have their floor and room. Aegis is watching everyone else.']
            : ['On track', 'Aegis is watching every building and every resident.'];
  return {
    phase: 'fire',
    headline,
    detail,
    stats: [
      { label: 'accounted for', value: told.length ? `${accounted.length}/${told.length}` : '—', tone: told.length && accounted.length === told.length ? 'ok' : undefined },
      { label: 'need help', value: String(needHelp), tone: needHelp ? 'bad' : undefined },
      ...(units.length ? [{ label: 'engines free', value: `${free.length}/${units.length}` }] : []),
      ...(lost ? [{ label: 'left behind', value: String(lost), tone: 'bad' as const }] : []),
    ],
    items: items.slice(0, 7),
  };
}

function endedAdvice(input: AdvisorInput, approved: Record<number, string[]>): Advice {
  const r = input.results;
  if (!r) return { phase: 'ended', headline: 'The fire is out', detail: 'Comparing with the same fire without Aegis…', stats: [], items: [] };
  const savedPeople = r.with.peopleSafe - r.without.peopleSafe;
  const avoided = r.without.damageUsd - r.with.damageUsd;
  const fewerClaims = r.without.claims - r.with.claims;
  // were fixes actually made before the fire? (a risk fix lowers the building's risk; a van fix adds a van)
  const fixedBuildings = input.buildings.filter((b) => real(b) && b.risk < b.baseRisk - 0.05);
  const vans = Object.entries(approved).some(([id, keys]) => keys.some((k) => (input.fixesFor(Number(id)).find((f) => f.key === k)?.addVans ?? 0) > 0));
  const fixed = fixedBuildings.length > 0 || vans;
  const expected = portfolio(input.buildings, input.profileFor);
  const across = expected && expected.avoided > 0
    ? `Across many fires, these fixes cut expected claims by ${fmtUsd(Math.round(expected.avoided))}.`
    : 'Across many fires, prep cuts expected claims.';
  const missed = fixedBuildings.length > 0 && fixedBuildings.every((b) => !b.touched && b.status !== 'lost');
  // Aegis's own run: who was left behind, and where
  const leftBehind = input.persons.filter((p) => p.status === 'left_behind');
  const left = leftBehind.length || Math.max(0, r.with.peopleTotal - r.with.peopleSafe);
  const where = [...new Set(leftBehind.map((p) => p.buildingId))].map((id) => input.buildings.find((b) => b.id === id)).filter((b): b is Building => !!b);
  const neverStarted = where.length > 0 && where.every((b) => !b.evacStarted);

  const headline = savedPeople > 0 ? `${savedPeople} more ${savedPeople === 1 ? 'person' : 'people'} safe`
    : savedPeople < 0 ? `${-savedPeople} fewer safe than without Aegis`
      : !left ? (avoided > 0 ? `Everyone safe, ${fmtUsd(Math.round(avoided))} less damage` : 'Everyone safe')
        : avoided > 0 ? `${fmtUsd(Math.round(avoided))} less damage` : 'Same outcome as without Aegis';
  const parts: string[] = [];
  if (avoided > 0) parts.push(`Compared with the same fire without Aegis: ${fmtUsd(Math.round(avoided))} less damage${fewerClaims > 0 ? ` and ${fewerClaims} fewer insurance claim${fewerClaims === 1 ? '' : 's'}` : ''}.`);
  else if (avoided < 0) parts.push(`Same fire, but it burned a different path this time: ${fmtUsd(Math.round(-avoided))} more damage than without Aegis.`);
  else parts.push(fixed ? 'Compared with the same fire without Aegis: the damage came out the same this time.' : 'Compared with the same fire without Aegis. Damage was the same: the buildings were not prepared before the fire.');
  if (savedPeople < 0) parts.push('Some evacuations started late. Start them when the coach first asks.');

  // prevention: from whether fixes were made, never claiming more than the results show
  const prep: Instruction = !fixed
    ? { id: 'why-prep', tone: 'soon', title: 'Next time: prepare first', why: 'Approve Aegis’s plan before the fire (Run again) to cut ignition risk and the claims that follow.' }
    : avoided > 0
      ? { id: 'why-prep', tone: 'good', title: 'Prevention paid first', why: 'Fixes made before the fire lowered ignition risk and documented Safer from Wildfires measures, so the claim never happens.' }
      : {
        id: 'why-prep', tone: 'info', title: 'Prevention paid first',
        why: `${avoided === 0 && missed ? 'This fire missed the buildings you fixed, so the damage did not change.'
          : `One fire is a roll of the dice, and this one ${avoided < 0 ? 'came out costlier' : 'did not come out cheaper'}.`} ${across}`,
      };
  const people: Instruction = !left
    ? { id: 'why-people', tone: 'good', title: 'No one was overlooked', why: 'Every resident was asked if they were safe; silent ones and the ones who could not walk were sent to staff, most urgent first.' }
    : {
      id: 'why-people', tone: 'now', title: `${left} resident${left === 1 ? ' was' : 's were'} left behind${where.length ? ` at ${where.map((b) => b.name).join(' and ')}` : ''}`,
      why: `${neverStarted ? 'The evacuation there never started.' : 'The evacuation there started too late.'} Run again and press Evacuate as soon as the coach asks for it.`,
    };
  return {
    phase: 'ended',
    headline,
    detail: parts.join(' '),
    stats: [
      // neutral colors when both runs kept the same number of people safe
      { label: 'safe', value: `${r.with.peopleSafe}/${r.with.peopleTotal}`, tone: savedPeople > 0 ? 'ok' : savedPeople < 0 ? 'bad' : undefined },
      { label: 'without Aegis', value: `${r.without.peopleSafe}/${r.without.peopleTotal}`, tone: savedPeople > 0 ? 'bad' : undefined },
      { label: 'buildings lost', value: `${r.with.buildingsLost} vs ${r.without.buildingsLost}` },
    ],
    items: [prep, people],
  };
}

export function advise(input: AdvisorInput, approved: Record<number, string[]>): Advice {
  if (input.sim.phase === 'prep') return prepAdvice(input, approved);
  if (input.sim.phase === 'fire') return fireAdvice(input);
  return endedAdvice(input, approved);
}
