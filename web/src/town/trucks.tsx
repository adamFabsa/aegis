// Fire units on the map. Each unit is ONE persistent engine sprite that is driven frame by frame along
// its route (no SMIL clock), so it keeps its place when the unit goes enroute -> onscene -> returning,
// a client that connects mid-trip sees it at the right point of the route, and it eases into the curb.
// Server ticks only re-anchor where the engine should be; between ticks it keeps driving at the speed
// the countdown implies, and a short low-pass filter hides any correction.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Building, Pack, Phase } from './types';
import type { Unit } from './mockWorld';
import { project } from './iso';
import { SPRITE, STAGING, onRoad, spriteScale, unitRoute } from './scene';
import { enginePark, headingOf, vehLook, vehOffset, type Heading } from './vehicleData';
import { VehicleSprite } from './vehicles';


type Pt = [number, number];
const HEADINGS: Heading[] = ['e', 'w', 's', 'n'];
const MAIN_E = 457; // eastbound lane of the main road (scene.ts LANE.mainE)
const SMOOTH = 0.22; // seconds: how quickly the drawn engine catches up with where it should be
const LEAD = 1.25; // ticks: how far the engine may run ahead of the last server tick (stops if ticks stop)
const FOLLOW = 46; // map units: how close an engine follows another one in its lane (an engine is ~34 long)
const CATCH_UP = 1.7; // after waiting behind another engine it catches up at most this much faster than it drives
const PASS = 16; // map units: how far an engine pulls over into the other lane to get past a parked or oncoming one
const PASS_SMOOTH = 0.3; // seconds: how quickly it changes lanes

/** Bay in the staging lot for the unit with this slot (stable by unit id, so bays never reshuffle). */
const bay = (slot: number): Pt => [STAGING[0] - 28 + slot * 28, STAGING[1] + 26];

/** Out of its own bay, up to the main road, then the shared route to the building's own place at the curb. */
function routeFor(slot: number, b: Building, all: Building[]): Pt[] {
  const [sx, sy] = bay(slot);
  return [[sx, sy], [sx, MAIN_E], ...unitRoute(b, all).slice(2)];
}

/** Engines run with lights and sirens on the way and on scene; once the fire is over they sit dark. */
const lightsOn = (u: Unit, phase: Phase) => phase !== 'ended' && (u.status === 'enroute' || u.status === 'onscene');

interface Path { pts: Pt[]; cum: number[]; total: number }
function measure(pts: Pt[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, total: cum[cum.length - 1] || 1 };
}
/** Point at fraction f of the path, and the index of the (non-empty) leg it is on. */
function along(p: Path, f: number): { x: number; y: number; leg: number } {
  const t = Math.min(1, Math.max(0, f)) * p.total;
  for (let i = 1; i < p.pts.length; i++) {
    const a = p.cum[i - 1];
    const b = p.cum[i];
    if (b - a < 0.01) continue;
    if (t <= b || i === p.pts.length - 1) {
      const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return { x: p.pts[i - 1][0] + (p.pts[i][0] - p.pts[i - 1][0]) * u, y: p.pts[i - 1][1] + (p.pts[i][1] - p.pts[i - 1][1]) * u, leg: i - 1 };
    }
  }
  const last = p.pts[p.pts.length - 1];
  return { x: last[0], y: last[1], leg: Math.max(0, p.pts.length - 2) };
}

/** Direction of travel (map unit vector) on the leg at fraction f, driving forward or backward. */
function legDir(p: Path, f: number, forward: boolean): Pt {
  const { leg } = along(p, f);
  const a = p.pts[leg];
  const b = p.pts[leg + 1] ?? a;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const s = forward ? 1 : -1;
  return [((b[0] - a[0]) / len) * s, ((b[1] - a[1]) / len) * s];
}

interface Motion {
  slot: number;
  key: string;
  status: Unit['status'] | '';
  ticksLeft: number;
  seenAt: number;
  tickSec: number;
  travel: number;
  targetId: number | null;
  rotation: number;
  route: Path | null; // null: standing in its bay
  f: number; // drawn position along the route, 0..1
  // where the engine should be: fObs + dir * rate * (seconds since tObs), kept within [lo, hi]
  fObs: number; tObs: number; dir: number; rate: number; lo: number; hi: number;
  returnFrom: number;
  x: number; y: number; hd: Heading; lights: boolean;
  /** route fraction per second it drives at (kept once on scene, for catching up) */
  drive: number;
  /** on its way somewhere (driving, or waiting to); waiting behind another engine (set by makeWay) */
  active: boolean; hold: boolean;
  /** direction of travel (map unit vector), speed (map units / s), distance still to go */
  ux: number; uy: number; speed: number; left: number;
  /** pulled over into the other lane to get past another engine (map units, eased) */
  ox: number; oy: number;
  /** its place at the building is clear of every building on screen (scene.ts engineCurb) */
  clear: boolean;
}

function newMotion(slot: number, tickSec: number): Motion {
  const [x, y] = bay(slot);
  return { slot, key: '', status: '', ticksLeft: 0, seenAt: 0, tickSec, travel: 3, targetId: null, rotation: -1, route: null, f: 0, fObs: 0, tObs: 0, dir: 0, rate: 0, lo: 0, hi: 0, returnFrom: 1, x, y, hd: headingOf([0, 0], [0, -1]), lights: false, drive: 0, active: false, hold: false, ux: 0, uy: -1, speed: 0, left: 0, ox: 0, oy: 0, clear: false };
}

/** A new row for this unit arrived: re-anchor where the engine should be. */
function observe(m: Motion, u: Unit, b: Building | undefined, all: Building[], rotation: number, now: number) {
  const key = `${u.status}|${u.ticksLeft}|${u.travelTicks}|${u.targetId}|${rotation}`;
  if (key === m.key) return;
  const first = m.key === '';
  // seconds per tick, learned from consecutive countdown steps (live 1.0 s, mock 0.7 s / speed)
  if (!first && u.status === m.status && u.ticksLeft === m.ticksLeft - 1 && m.ticksLeft < u.travelTicks) {
    const dt = (now - m.seenAt) / 1000;
    if (dt > 0.08 && dt < 3) m.tickSec = m.tickSec * 0.5 + dt * 0.5;
  }
  const prevStatus = m.status;
  m.key = key;
  m.seenAt = now;
  m.status = u.status;
  m.ticksLeft = u.ticksLeft;
  m.tObs = now;
  const T = Math.max(1, u.travelTicks);
  const away = u.status === 'enroute' || u.status === 'onscene' || u.status === 'returning';
  const turned = rotation !== m.rotation;
  let rebuilt = false;
  if (away && b && (u.targetId !== m.targetId || turned || !m.route)) {
    const fresh = u.targetId !== m.targetId && (!m.route || m.f < 0.002);
    m.route = measure(routeFor(m.slot, b, all));
    m.clear = enginePark(b, all).clear;
    if (fresh) m.f = 0;
    rebuilt = true;
  }
  m.targetId = away ? u.targetId : m.targetId;
  m.rotation = rotation;
  if (u.status === 'enroute') {
    m.travel = T;
    m.fObs = (T - u.ticksLeft) / T;
    m.rate = 1 / (T * m.tickSec);
    m.dir = 1;
    m.lo = m.fObs;
    m.hi = Math.min(1, m.fObs + LEAD / T);
  } else if (u.status === 'onscene') {
    m.fObs = 1; m.dir = 0; m.rate = 0; m.lo = 1; m.hi = 1;
  } else if (u.status === 'returning') {
    // a unit called back on its way turns around where it is; one on scene drives the whole way back
    if (prevStatus !== 'returning') m.returnFrom = first || !m.route ? 1 : Math.max(0.02, m.f);
    m.fObs = (m.returnFrom * u.ticksLeft) / T;
    m.rate = m.returnFrom / (T * m.tickSec);
    m.dir = -1;
    m.hi = m.fObs;
    m.lo = Math.max(0, m.fObs - (LEAD * m.returnFrom) / T);
  } else if (m.route && !first && m.f > 0.002) {
    // released while away (the fire went out): drive home instead of teleporting to the bay
    m.fObs = m.f;
    m.rate = 1 / (Math.max(2, m.travel) * m.tickSec);
    m.dir = -1;
    m.hi = m.f;
    m.lo = 0;
  } else {
    m.route = null;
  }
  if (first && m.route) m.f = Math.min(m.hi, Math.max(m.lo, m.fObs));
  if (m.rate > 0) m.drive = m.rate;
  // face the way it drives (or drove in): also for a client that joins while the engine is parked, and after the
  // view turns (headings are on-screen directions)
  if (m.route && (rebuilt || first)) {
    [m.ux, m.uy] = legDir(m.route, m.f, u.status !== 'returning');
    m.hd = headingOf([0, 0], [m.ux, m.uy]);
  } else if (!m.route && turned) {
    m.hd = headingOf([0, 0], [0, -1]); // in its bay, nose out
  }
}

/** Advance one frame; returns true while the engine is still moving (or waiting to). */
function step(m: Motion, now: number, dt: number): boolean {
  if (m.route) {
    const ft = Math.min(m.hi, Math.max(m.lo, m.fObs + m.dir * m.rate * ((now - m.tObs) / 1000)));
    const prev = m.f;
    // ease toward where it should be, but never faster than CATCH_UP times its driving speed (after waiting
    // behind another engine it catches up instead of jumping), and not at all while it waits
    const cap = Math.max(m.drive, 0.02) * CATCH_UP * dt;
    const move = Math.max(-cap, Math.min(cap, (ft - m.f) * (1 - Math.exp(-dt / SMOOTH))));
    if (!m.hold) m.f = Math.abs(ft - m.f - move) < 2e-4 ? ft : m.f + move;
    const p = along(m.route, m.f);
    m.x = p.x;
    m.y = p.y;
    const fwd = m.f > prev + 1e-6;
    if (fwd || m.f < prev - 1e-6) {
      [m.ux, m.uy] = legDir(m.route, m.f, fwd);
      m.hd = headingOf([0, 0], [m.ux, m.uy]);
      m.left = (fwd ? 1 - m.f : m.f) * m.route.total;
    }
    m.speed = m.drive * m.route.total;
    // home: back in the bay
    if (m.status === 'ready' && m.f <= 1e-4) { m.route = null; m.active = false; return false; }
    // still easing, or still driving toward a bound it has not reached (paused sim: it stops at the lead)
    m.active = m.f !== ft || (m.dir !== 0 && ft !== (m.dir > 0 ? m.hi : m.lo));
    return m.active;
  }
  m.active = false;
  const [bx, by] = bay(m.slot);
  const k = 1 - Math.exp(-dt / SMOOTH);
  m.x += (bx - m.x) * k;
  m.y += (by - m.y) * k;
  if (Math.hypot(bx - m.x, by - m.y) < 0.05) { m.x = bx; m.y = by; return false; }
  return true;
}

/** Where o is from m: how far ahead along m's direction of travel, and how far to the side (map units). */
function relative(m: Motion, o: Motion): { ahead: number; side: number } {
  const rx = o.x + o.ox - m.x;
  const ry = o.y + o.oy - m.y;
  return { ahead: rx * m.ux + ry * m.uy, side: Math.abs(rx * m.uy - ry * m.ux) };
}

/** o is just ahead of m, in its lane. */
function inTheWay(m: Motion, o: Motion): boolean {
  const { ahead, side } = relative(m, o);
  return side < 14 && ahead > 0 && ahead < FOLLOW;
}

/**
 * Engines on a street do not drive through each other. Going the same way (or merging) one waits a length behind
 * the other and catches up once the road is clear (of two that meet, the lower slot goes first); past an engine
 * parked in its lane, or one coming the other way, it pulls into the other lane and back (of two oncoming engines
 * only the faster one moves over). Returns true while any engine is still changing lanes.
 */
function makeWay(list: Motion[], dt: number): boolean {
  const k = 1 - Math.exp(-dt / PASS_SMOOTH);
  let busy = false;
  for (const m of list) {
    let hold = false;
    let tx = 0;
    let ty = 0;
    if (m.route && m.active) {
      for (const o of list) {
        if (o === m || !o.route) continue;
        const oncoming = o.ux * m.ux + o.uy * m.uy < -0.5;
        if (o.active && !oncoming) {
          if (inTheWay(m, o) && !(inTheWay(o, m) && m.slot < o.slot)) hold = true;
          continue;
        }
        if (o.active && (o.speed > m.speed || (o.speed === m.speed && o.slot > m.slot))) continue; // that one moves over
        const { ahead, side } = relative(m, o);
        const closing = m.speed + (o.active ? o.speed : 0);
        const look = 40 + closing * 0.45; // start moving over in time to finish the lane change
        // (an engine parked beyond where this one stops is not in its way)
        if (side > 13 || ahead < -40 || ahead > Math.min(look, m.left + 6)) continue;
        // over to the side that is still street: the other lane
        const lx = m.uy;
        const ly = -m.ux;
        const s = onRoad(m.x + lx * PASS, m.y + ly * PASS) ? 1 : onRoad(m.x - lx * PASS, m.y - ly * PASS) ? -1 : 0;
        if (!s) continue;
        tx = lx * PASS * s;
        ty = ly * PASS * s;
      }
    }
    m.hold = hold;
    m.ox += (tx - m.ox) * k;
    m.oy += (ty - m.oy) * k;
    if (Math.abs(tx - m.ox) + Math.abs(ty - m.oy) < 0.05) { m.ox = tx; m.oy = ty; } else busy = true;
  }
  return busy;
}

/** Put an engine element where the engine is drawn, facing its way, lights on or off. */
function place(el: SVGGElement, m: Motion) {
  const [sx, sy] = project(m.x + m.ox, m.y + m.oy);
  el.setAttribute('transform', `translate(${sx.toFixed(2)} ${sy.toFixed(2)})`);
  if (el.dataset.hd !== m.hd) {
    el.dataset.hd = m.hd;
    // the light bar sits on the cab roof, which is a different screen offset for each heading
    const [lx, ly] = vehOffset(m.hd, 12.2, 12.8);
    el.querySelector('.bar')?.setAttribute('transform', `translate(${lx.toFixed(2)} ${ly.toFixed(2)})`);
  }
  const lights = m.lights ? 'on' : 'off';
  if (el.dataset.lights !== lights) el.dataset.lights = lights;
}

/**
 * Paint the engine, and its copy above the town (OnScene): the copy fades in once the engine has pulled in at its
 * place, which no building covers, so trees and smoke do not hide a parked engine and its hoses start on top of it.
 */
function paint(m: Motion, el: SVGGElement | null | undefined, top: SVGGElement | null | undefined) {
  if (el) place(el, m);
  if (!top) return;
  place(top, m);
  const parked = m.status === 'onscene' && m.clear && m.route !== null && m.f >= 1 - 1e-6 && Math.abs(m.ox) + Math.abs(m.oy) < 0.5;
  const op = parked ? '1' : '0';
  if (top.style.opacity !== op) top.style.opacity = op;
}

interface Props {
  units: Unit[];
  buildings: Building[];
  /** real seconds per server tick (live 1.0, mock 0.7); refined from the countdown as ticks arrive */
  tickSeconds: number;
  pack: Pack;
  layer: 'under' | 'over';
  lite?: boolean;
  rotation?: number;
  /** once the fire is over ('ended') the engines switch their lights off */
  phase?: Phase;
}

/**
 * Fire units in two layers: 'under' (the engines themselves, driving below the buildings so a building in front
 * hides them) and 'over' (above the town: each engine on scene, whose place no building covers (scene.ts
 * engineCurb), so trees and smoke do not hide it either, then the hoses and mist).
 */
export function FireUnits({ units, buildings, tickSeconds, pack, layer, lite = false, rotation = 0, phase = 'fire' }: Props) {
  if (layer === 'over') return <OnScene units={units} buildings={buildings} pack={pack} lite={lite} />;
  return <Engines units={units} buildings={buildings} tickSeconds={tickSeconds} pack={pack} rotation={rotation} phase={phase} />;
}

function Engines({ units, buildings, tickSeconds, pack, rotation, phase }: { units: Unit[]; buildings: Building[]; tickSeconds: number; pack: Pack; rotation: number; phase: Phase }) {
  const motions = useRef(new Map<number, Motion>());
  const els = useRef(new Map<number, SVGGElement>());
  const raf = useRef(0);
  const last = useRef(0);
  const look = vehLook(pack);
  const order = [...units].sort((a, b) => a.id - b.id);
  // the engine's copy above the town, rendered by the 'over' layer (OnScene)
  const topOf = (id: number) => els.current.get(id)?.ownerSVGElement?.querySelector<SVGGElement>(`g[data-top="${id}"]`);

  const loop = useRef<(now: number) => void>(() => {});
  useLayoutEffect(() => {
    loop.current = (now: number) => {
      const dt = Math.min(0.1, Math.max(0.001, (now - (last.current || now)) / 1000));
      last.current = now;
      let busy = false;
      for (const m of motions.current.values()) if (step(m, now, dt)) busy = true;
      if (makeWay([...motions.current.values()], dt)) busy = true;
      for (const [id, m] of motions.current) paint(m, els.current.get(id), topOf(id));
      raf.current = busy ? requestAnimationFrame((t) => loop.current(t)) : 0;
    };
  });

  // every new snapshot re-anchors the engines and paints them before the browser shows the frame
  useLayoutEffect(() => {
    const now = performance.now();
    const seen = new Set<number>();
    order.forEach((u, slot) => {
      seen.add(u.id);
      let m = motions.current.get(u.id);
      if (!m) { m = newMotion(slot, tickSeconds); motions.current.set(u.id, m); }
      m.slot = slot;
      observe(m, u, buildings.find((x) => x.id === u.targetId), buildings, rotation, now);
      m.lights = lightsOn(u, phase);
      if (!raf.current) step(m, now, 0.001);
      paint(m, els.current.get(u.id), topOf(u.id));
    });
    for (const id of [...motions.current.keys()]) if (!seen.has(id)) motions.current.delete(id);
    if (!raf.current) { last.current = 0; raf.current = requestAnimationFrame((t) => loop.current(t)); }
  });
  // (reset the id too: StrictMode mounts twice, and a stale id would keep the loop from restarting)
  useEffect(() => () => { cancelAnimationFrame(raf.current); raf.current = 0; }, []);

  return (
    <g style={{ pointerEvents: 'none' }}>
      <defs>
        <radialGradient id="beacon"><stop offset="0" stopColor="#FF5A4E" stopOpacity="0.8" /><stop offset="1" stopColor="#FF5A4E" stopOpacity="0" /></radialGradient>
        <radialGradient id="mist"><stop offset="0" stopColor="#E4F5FF" stopOpacity="0.75" /><stop offset="0.6" stopColor="#CFEFFF" stopOpacity="0.3" /><stop offset="1" stopColor="#CFEFFF" stopOpacity="0" /></radialGradient>
        <radialGradient id="washRed"><stop offset="0" stopColor="#FF3B30" stopOpacity="0.38" /><stop offset="1" stopColor="#FF3B30" stopOpacity="0" /></radialGradient>
        <radialGradient id="washBlue"><stop offset="0" stopColor="#4C8DFF" stopOpacity="0.34" /><stop offset="1" stopColor="#4C8DFF" stopOpacity="0" /></radialGradient>
        <linearGradient id="jet" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#FFFFFF" /><stop offset="0.7" stopColor="#CDEBFF" /><stop offset="1" stopColor="#A9DEFF" stopOpacity="0.6" /></linearGradient>
      </defs>
      {order.map((u) => (
        <g key={u.id} className="truck" ref={(el) => { if (el) els.current.set(u.id, el); else els.current.delete(u.id); }}>
          {/* red and blue light washing the road around the engine while it runs with lights on */}
          <g className="wash">
            <ellipse cx="0" cy="-2" rx="34" ry="17" fill="url(#washRed)"><animate attributeName="opacity" values="0.9;0.1;0.9" dur="0.5s" repeatCount="indefinite" /></ellipse>
            <ellipse cx="0" cy="-2" rx="34" ry="17" fill="url(#washBlue)"><animate attributeName="opacity" values="0.1;0.9;0.1" dur="0.5s" repeatCount="indefinite" /></ellipse>
          </g>
          {HEADINGS.map((hd) => (
            <g key={hd} className={`hd hd-${hd}`}><VehicleSprite model="engine" hd={hd} look={look} /></g>
          ))}
          <g className="bar"><LightBar /></g>
        </g>
      ))}
    </g>
  );
}

/** A hose line: from the parked engine's deck gun (screen sx, sy) to the roof (tx, ty). */
interface Jet { key: string; sx: number; sy: number; tx: number; ty: number; seed: number }

/** The hoses that run now: an engine on scene at a building that is burning. */
function jets(units: Unit[], buildings: Building[]): Jet[] {
  const out: Jet[] = [];
  for (const u of units) {
    if (u.status !== 'onscene') continue;
    const b = buildings.find((x) => x.id === u.targetId);
    if (!b || b.status !== 'burning') continue;
    // the same place the engine drove to (scene.ts engineCurb), so the water leaves the engine itself
    const { x, y, hd } = enginePark(b, buildings);
    const [ex, ey] = project(x, y);
    const [nx, ny] = vehOffset(hd, -6, 13);
    // aim at the part of the roof nearest the engine (a long row of homes is not hosed from end to end)
    const ax = Math.min(b.x + b.w * 0.7, Math.max(b.x + b.w * 0.3, x));
    const ay = Math.min(b.y + b.h * 0.7, Math.max(b.y + b.h * 0.3, y));
    const [tx, ty] = project(ax, ay, SPRITE[b.kind].roof * spriteScale(b));
    out.push({ key: `s${u.id}-${b.id}`, sx: ex + nx, sy: ey + ny, tx, ty, seed: u.id * 2 });
  }
  return out;
}

/** Hoses that just stopped (the building stopped burning, or the engine left), kept for `ms` while they fade out. */
function useStopped(live: Jet[], ms: number): Jet[] {
  const [seen, setSeen] = useState<{ sig: string; live: Jet[]; out: Jet[] }>({ sig: '', live: [], out: [] });
  const sig = live.map((j) => `${j.key}@${j.sx.toFixed(0)},${j.sy.toFixed(0)}`).join(' ');
  if (sig !== seen.sig) {
    const keys = new Set(live.map((j) => j.key));
    const out = new Map<string, Jet>();
    for (const j of [...seen.out, ...seen.live]) if (!keys.has(j.key)) out.set(j.key, j);
    setSeen({ sig, live, out: [...out.values()] });
  }
  useEffect(() => {
    if (!seen.out.length) return;
    const t = setTimeout(() => setSeen((s) => ({ ...s, out: [] })), ms);
    return () => clearTimeout(t);
  }, [seen.out, ms]);
  return seen.out;
}

/**
 * Above the town: a copy of every engine, which Engines paints along with it and shows only while it stands at its
 * place on scene (clear of the buildings, so trees and smoke would be the only things over it), then the water.
 * Water on the building only while it is actually burning: an engine sent ahead of the fire parks with its lights
 * on and the crew standing by; the hoses fade in the moment the building catches, and fade out when it stops.
 */
function OnScene({ units, buildings, pack, lite }: { units: Unit[]; buildings: Building[]; pack: Pack; lite: boolean }) {
  const live = jets(units, buildings);
  const stopped = useStopped(live, 1000);
  const look = vehLook(pack);
  const draw = (j: Jet) => {
    const cy = Math.min(j.sy, j.ty) - 40;
    return [0, 1].map((k) => (
      <HoseStream key={k} sx={j.sx} sy={j.sy} tx={j.tx + (k ? 16 : -12)} ty={j.ty + (k ? 4 : -2)} lift={(cy - Math.min(j.sy, j.ty)) + (k ? -6 : 0)} seed={j.seed + k} lite={lite} />
    ));
  };
  return (
    <g style={{ pointerEvents: 'none' }}>
      {[...units].sort((a, b) => a.id - b.id).map((u) => (
        <g key={u.id} className="truck truck-top" data-top={u.id} style={{ opacity: 0, transition: 'opacity 0.45s ease' }}>
          {HEADINGS.map((hd) => (
            <g key={hd} className={`hd hd-${hd}`}><VehicleSprite model="engine" hd={hd} look={look} /></g>
          ))}
          <g className="bar"><LightBar /></g>
        </g>
      ))}
      {live.map((j) => <g key={j.key} className="hose-in">{draw(j)}</g>)}
      {stopped.map((j) => <g key={`${j.key}-off`} className="hose-off" style={{ animation: 'pack-out 0.9s ease forwards' }}>{draw(j)}</g>)}
    </g>
  );
}

/** Red and blue light bar on an engine's cab roof, flashing (paint() moves it onto the cab per heading). */
function LightBar() {
  return (
    <>
      <circle r="11" fill="url(#beacon)"><animate attributeName="opacity" values="0.7;0.1;0.7" dur="0.5s" repeatCount="indefinite" /></circle>
      <circle cx="-1.2" r="1.1" fill="#FF3B30"><animate attributeName="opacity" values="1;0.15;1" dur="0.5s" repeatCount="indefinite" /></circle>
      <circle cx="1.2" cy="0.4" r="1.1" fill="#4C8DFF"><animate attributeName="opacity" values="0.15;1;0.15" dur="0.5s" repeatCount="indefinite" /></circle>
    </>
  );
}

/**
 * A fire stream: water leaves the deck gun, arcs under gravity (a parabola), breaks into droplets
 * along the way, hits the building in a burst of spray, runs down the wall and hangs as mist.
 */
function HoseStream({ sx, sy, tx, ty, lift, seed, lite }: { sx: number; sy: number; tx: number; ty: number; lift: number; seed: number; lite: boolean }) {
  // quadratic Bezier with its apex `lift` above the higher end: the shape of a jet under gravity
  const dist = Math.hypot(tx - sx, ty - sy);
  const qx = (sx + tx) / 2 + (tx - sx) * 0.12;
  const qy = Math.min(sy, ty) - 10 - dist * 0.14 + lift * 0.1;
  const d = `M${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
  const j = (n: number) => ((seed * 9301 + n * 49297) % 233280) / 233280; // stable jitter
  const drops = lite ? 6 : 14;
  const splash = lite ? 5 : 10;
  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* the jet: a soft spray envelope around a bright core that flickers as it breaks up */}
      {!lite && <path d={d} stroke="#CFEFFF" strokeWidth="5.5" fill="none" strokeLinecap="round" opacity="0.18" filter="url(#blur2)" />}
      <path d={d} stroke="url(#jet)" strokeWidth="2.2" fill="none" strokeLinecap="round" opacity="0.85">
        <animate attributeName="stroke-width" values="2.2;1.6;2.4;1.9;2.2" dur="0.5s" repeatCount="indefinite" />
      </path>
      <path d={d} stroke="#F4FBFF" strokeWidth="0.9" fill="none" strokeLinecap="round" strokeDasharray="7 5 2 6" opacity="0.9">
        <animate attributeName="stroke-dashoffset" from="40" to="0" dur="0.35s" repeatCount="indefinite" />
      </path>
      {/* droplets riding the stream, spreading a little as they fly */}
      {Array.from({ length: drops }, (_, i) => (
        <circle key={`d${i}`} r={0.6 + j(i) * 0.7} fill="#E9F7FF" opacity="0.9">
          <animateMotion path={d} dur={`${0.55 + j(i + 3) * 0.2}s`} begin={`${-i * 0.06}s`} repeatCount="indefinite" />
          <animateTransform attributeName="transform" type="translate" values={`0 0;${(j(i + 7) - 0.5) * 6} ${(j(i + 9) - 0.2) * 5}`} dur={`${0.55 + j(i + 3) * 0.2}s`} begin={`${-i * 0.06}s`} repeatCount="indefinite" additive="sum" />
        </circle>
      ))}
      {/* impact: spray bursts out and falls back */}
      <g transform={`translate(${tx.toFixed(1)} ${ty.toFixed(1)})`}>
        {Array.from({ length: splash }, (_, i) => {
          const ang = -Math.PI * (0.1 + 0.8 * j(i + 20));
          const dist = 8 + j(i + 30) * 14;
          const ex = Math.cos(ang) * dist;
          const ey = Math.sin(ang) * dist * 0.7;
          const dur = 0.5 + j(i + 40) * 0.4;
          return (
            <circle key={`s${i}`} r={0.6 + j(i + 50) * 0.8} fill="#F2FAFF">
              <animateMotion path={`M0 0 Q ${(ex * 0.6).toFixed(1)} ${(ey - 6).toFixed(1)} ${ex.toFixed(1)} ${(ey + 10).toFixed(1)}`} dur={`${dur}s`} begin={`${-j(i + 60) * dur}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.95;0.7;0" dur={`${dur}s`} begin={`${-j(i + 60) * dur}s`} repeatCount="indefinite" />
            </circle>
          );
        })}
        {/* water running down the wall */}
        {!lite && [0, 1, 2].map((i) => (
          <circle key={`r${i}`} r="0.7" fill="#D8F0FF">
            <animateMotion path={`M${(i - 1) * 5} 2 L ${(i - 1) * 5 + 1} 34`} dur={`${0.9 + i * 0.25}s`} begin={`${-i * 0.3}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" values="0;0.8;0.5;0" dur={`${0.9 + i * 0.25}s`} begin={`${-i * 0.3}s`} repeatCount="indefinite" />
          </circle>
        ))}
        {/* mist hanging where the water hits */}
        <ellipse rx="16" ry="10" fill="url(#mist)" opacity="0.8">
          <animate attributeName="rx" values="13;20;13" dur="1.3s" repeatCount="indefinite" />
          <animate attributeName="ry" values="8;12;8" dur="1.3s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.55;0.85;0.55" dur="1.3s" repeatCount="indefinite" />
        </ellipse>
      </g>
    </g>
  );
}

