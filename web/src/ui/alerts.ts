// Per-building people alerts: who needs someone now, who hasn't answered, who has help on the way, who was
// left behind. One definition for the map badges, the phone's Alerts tab and the building card.
import type { Building, Person, Sim, Task } from '../town/types';

export type AlertKind = 'left_behind' | 'needs_help' | 'no_reply' | 'help_coming';
export interface PersonAlert {
  person: Person;
  kind: AlertKind;
  /** the open help task, if any (for "Send staff") */
  taskId?: number;
  claimedBy?: string;
  /** sim-minutes since the check-in went out */
  minutes: number;
}
export interface BuildingAlerts {
  buildingId: number;
  needHelp: number;
  noReply: number;
  helpComing: number;
  leftBehind: number;
  /** most urgent first */
  people: PersonAlert[];
}

/** A resident counts as "no reply" once they've been silent this long (sim-minutes), before escalation. */
const QUIET_MIN = 5;
const ORDER: Record<AlertKind, number> = { left_behind: 0, needs_help: 1, no_reply: 2, help_coming: 3 };

export function buildingAlerts(sim: Sim, buildings: Building[], persons: Person[], tasks: Task[]): Map<number, BuildingAlerts> {
  const out = new Map<number, BuildingAlerts>();
  if (sim.phase === 'prep') return out;
  const openTask = new Map<number, Task>();
  for (const t of tasks) if (!t.done && t.personId) openTask.set(t.personId, t);
  const mpt = Math.max(1, sim.minutesPerTick);
  for (const p of persons) {
    const t = openTask.get(p.id);
    const minutes = Math.max(0, (sim.tick - p.pingedAtTick) * mpt);
    let kind: AlertKind | null = null;
    if (p.status === 'left_behind') kind = 'left_behind';
    else if (t && !t.claimedBy) kind = 'needs_help';
    else if (t && t.claimedBy) kind = 'help_coming';
    else if (p.status === 'pinged' && !p.replyText && minutes >= QUIET_MIN) kind = 'no_reply';
    if (!kind) continue;
    let a = out.get(p.buildingId);
    if (!a) out.set(p.buildingId, (a = { buildingId: p.buildingId, needHelp: 0, noReply: 0, helpComing: 0, leftBehind: 0, people: [] }));
    if (kind === 'left_behind') a.leftBehind++;
    else if (kind === 'needs_help') a.needHelp++;
    else if (kind === 'no_reply') a.noReply++;
    else a.helpComing++;
    a.people.push({ person: p, kind, taskId: t?.id, claimedBy: t?.claimedBy || undefined, minutes });
  }
  for (const a of out.values()) {
    a.people.sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || Number(y.person.needsHelp) - Number(x.person.needsHelp) || y.minutes - x.minutes);
  }
  // drop buildings that no longer exist (scenario switch) and keep map order stable
  const ids = new Set(buildings.map((b) => b.id));
  for (const id of [...out.keys()]) if (!ids.has(id)) out.delete(id);
  return out;
}

/** The headline count for a building's badge: the most urgent kind that is non-zero. */
export function badgeFor(a: BuildingAlerts | undefined): { tone: 'bad' | 'warn'; text: string } | null {
  if (!a) return null;
  if (a.leftBehind) return { tone: 'bad', text: `${a.leftBehind} left behind` };
  if (a.needHelp) return { tone: 'bad', text: `${a.needHelp} need${a.needHelp === 1 ? 's' : ''} help` };
  if (a.noReply) return { tone: 'warn', text: `${a.noReply} no reply` };
  if (a.helpComing) return { tone: 'warn', text: `${a.helpComing} help coming` };
  return null;
}

export const ALERT_LABEL: Record<AlertKind, string> = {
  left_behind: 'Left behind',
  needs_help: 'Needs help',
  no_reply: 'No reply',
  help_coming: 'Help coming',
};

/** A stable number from a name, for portraits (staff have names, not ids). */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
