/**
 * Fire engines (the public `unit` table). Pure functions over plain rows so they can be unit-tested.
 *
 *  - The fire department answers buildings that are already burning (auto-dispatch), as it would without
 *    Lantern, but always keeps one engine in reserve.
 *  - Lantern's advisor can send an engine AHEAD of the fire (dispatch_unit). An engine on scene before the
 *    fire arrives lowers that building's ignition probability (sim.ts, p.engineProtect).
 *  - Engines drive back to staging when their building is lost or when released.
 * Travel is counted in ticks (one tick = 1 s of real time) so trucks drive at the same pace at any speed.
 */
export type UnitStatus = 'ready' | 'enroute' | 'onscene' | 'returning';
export interface UnitRow {
  id: number;
  name: string;
  status: string; // UnitStatus
  targetId: number; // building id, 0 = none
  ticksLeft: number;
  travelTicks: number;
}
interface BuildingLike {
  id: number;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: string;
  residents: number;
  peopleOut: number;
  risk: number;
}

/** Staging lot (map units), the same point the web client drives engines from (web/src/town/scene.ts STAGING). */
export const STAGING: [number, number] = [72, 540];
/** Engines the auto-dispatch leaves free for Lantern's own call. */
export const RESERVE = 1;

export function freshUnits(): UnitRow[] {
  return [
    { id: 1, name: 'Engine 1', status: 'ready', targetId: 0, ticksLeft: 0, travelTicks: 0 },
    { id: 2, name: 'Engine 2', status: 'ready', targetId: 0, ticksLeft: 0, travelTicks: 0 },
    { id: 3, name: 'Truck 3', status: 'ready', targetId: 0, ticksLeft: 0, travelTicks: 0 },
  ];
}

/** Ticks to drive from staging to a building: 5–10 (a 5–10 s drive on screen). */
export function travelTicks(b: BuildingLike): number {
  const d = Math.hypot(b.x + b.w / 2 - STAGING[0], b.y + b.h / 2 - STAGING[1]);
  return Math.max(5, Math.min(10, 4 + Math.round(d / 140)));
}

/** A unit assigned to a building (driving there or on scene). */
export const assigned = (u: UnitRow) => u.status === 'enroute' || u.status === 'onscene';

/** Building ids with an engine on scene (what the fire engine reads). */
export function protectedIds(units: UnitRow[]): number[] {
  return units.filter((u) => u.status === 'onscene' && u.targetId).map((u) => u.targetId);
}

export function canReceive(b: BuildingLike | undefined): string | null {
  if (!b) return 'building not found';
  if (b.kind === 'shelter') return 'the shelter does not need an engine';
  if (b.status === 'lost') return `${b.name} is already lost`;
  return null;
}

/** Send a ready unit to a building. Mutates the chosen unit; returns it and a log line, or an error. */
export function dispatch(units: UnitRow[], b: BuildingLike, ahead: boolean): { unit?: UnitRow; event?: string; error?: string } {
  const err = canReceive(b);
  if (err) return { error: err };
  if (units.some((u) => assigned(u) && u.targetId === b.id)) return { error: `an engine is already assigned to ${b.name}` };
  const u = units.find((x) => x.status === 'ready');
  if (!u) return { error: 'no engine free: release one first' };
  const t = travelTicks(b);
  Object.assign(u, { status: 'enroute', targetId: b.id, ticksLeft: t, travelTicks: t });
  return { unit: u, event: ahead ? `${u.name} sent ahead of the fire to ${b.name}` : `${u.name} responding to ${b.name} (on fire)` };
}

/** Bring a unit back to staging. A unit still driving turns around; one on scene drives the whole way back. */
export function release(u: UnitRow): { event?: string; error?: string } {
  if (u.status === 'ready' || u.status === 'returning') return { error: `${u.name} is not assigned` };
  const back = u.status === 'enroute' ? Math.max(1, u.travelTicks - u.ticksLeft) : u.travelTicks;
  Object.assign(u, { status: 'returning', ticksLeft: back, travelTicks: back });
  return { event: `${u.name} returning to staging` };
}

/**
 * One tick for every unit: drive, arrive, return from lost buildings, then auto-dispatch to burning
 * buildings (most people still inside first) while more than RESERVE engines are free.
 * Returns the units that changed and the log lines.
 */
export function stepUnits(units: UnitRow[], buildings: BuildingLike[]): { changed: UnitRow[]; events: string[] } {
  const changed = new Set<UnitRow>();
  const events: string[] = [];
  const byId = new Map(buildings.map((b) => [b.id, b]));
  for (const u of units) {
    const b = byId.get(u.targetId);
    if (u.status === 'returning') {
      u.ticksLeft -= 1;
      if (u.ticksLeft <= 0) {
        Object.assign(u, { status: 'ready', targetId: 0, ticksLeft: 0, travelTicks: 0 });
        events.push(`${u.name} back at staging, ready`);
      }
      changed.add(u);
      continue;
    }
    if (!assigned(u)) continue;
    if (!b || b.status === 'lost') {
      Object.assign(u, { status: 'returning', ticksLeft: u.travelTicks, travelTicks: u.travelTicks });
      events.push(`${u.name} returning to staging: ${b?.name ?? 'its building'} was lost`);
      changed.add(u);
      continue;
    }
    if (u.status === 'enroute') {
      u.ticksLeft -= 1;
      if (u.ticksLeft <= 0) {
        u.status = 'onscene';
        u.ticksLeft = 0;
        events.push(b.status === 'burning' ? `${u.name} on scene at ${b.name}, water on the building` : `${u.name} on scene at ${b.name}, crew standing by`);
      }
      changed.add(u);
    }
  }
  const burning = buildings
    .filter((b) => b.status === 'burning' && !units.some((u) => assigned(u) && u.targetId === b.id))
    .sort((a, b) => (b.residents - b.peopleOut) - (a.residents - a.peopleOut) || b.risk - a.risk || a.id - b.id);
  for (const b of burning) {
    if (units.filter((u) => u.status === 'ready').length <= RESERVE) break;
    const r = dispatch(units, b, false);
    if (r.unit) {
      changed.add(r.unit);
      events.push(r.event!);
    }
  }
  return { changed: [...changed], events };
}
