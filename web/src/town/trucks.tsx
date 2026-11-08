// Fire units on the map. Each unit is ONE persistent engine sprite that is driven frame by frame along
// its route (no SMIL clock), so it keeps its place when the unit goes enroute -> onscene -> returning,
// a client that connects mid-trip sees it at the right point of the route, and it eases into the curb.
// Server ticks only re-anchor where the engine should be; between ticks it keeps driving at the speed
// the countdown implies, and a short low-pass filter hides any correction.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Building, Pack } from './types';
import type { Unit } from './mockWorld';
import { project } from './iso';
import { SPRITE, STAGING, spriteScale, unitRoute } from './scene';
import { enginePark, headingOf, vehLook, vehOffset, type Heading } from './vehicleData';
import { VehicleSprite } from './vehicles';


type Pt = [number, number];
const HEADINGS: Heading[] = ['e', 'w', 's', 'n'];
const MAIN_E = 457; // eastbound lane of the main road (scene.ts LANE.mainE)
const SMOOTH = 0.22; // seconds: how quickly the drawn engine catches up with where it should be
const LEAD = 1.25; // ticks: how far the engine may run ahead of the last server tick (stops if ticks stop)

/** Bay in the staging lot for the unit with this slot (stable by unit id, so bays never reshuffle). */
const bay = (slot: number): Pt => [STAGING[0] - 28 + slot * 28, STAGING[1] + 26];

/** Out of its own bay, up to the main road, then the shared route to the curb by the building. */
function routeFor(slot: number, b: Building, all: Building[]): Pt[] {
  const [sx, sy] = bay(slot);
  return [[sx, sy], [sx, MAIN_E], ...unitRoute(b, all).slice(2)];
}

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
}

function newMotion(slot: number, tickSec: number): Motion {
  const [x, y] = bay(slot);
  return { slot, key: '', status: '', ticksLeft: 0, seenAt: 0, tickSec, travel: 3, targetId: null, rotation: -1, route: null, f: 0, fObs: 0, tObs: 0, dir: 0, rate: 0, lo: 0, hi: 0, returnFrom: 1, x, y, hd: headingOf([0, 0], [0, -1]), lights: false };
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
  if (away && b && (u.targetId !== m.targetId || rotation !== m.rotation || !m.route)) {
    const fresh = u.targetId !== m.targetId && (!m.route || m.f < 0.002);
    m.route = measure(routeFor(m.slot, b, all));
    if (fresh) m.f = 0;
  }
  m.targetId = away ? u.targetId : m.targetId;
  m.rotation = rotation;
  m.lights = u.status === 'enroute' || u.status === 'onscene';
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
}

/** Advance one frame; returns true while the engine is still moving. */
function step(m: Motion, now: number, dt: number): boolean {
  if (m.route) {
    const ft = Math.min(m.hi, Math.max(m.lo, m.fObs + m.dir * m.rate * ((now - m.tObs) / 1000)));
    const prev = m.f;
    m.f += (ft - m.f) * (1 - Math.exp(-dt / SMOOTH));
    if (Math.abs(ft - m.f) < 2e-4) m.f = ft;
    const p = along(m.route, m.f);
    m.x = p.x;
    m.y = p.y;
    const a = m.route.pts[p.leg];
    const b = m.route.pts[p.leg + 1] ?? a;
    if (m.f > prev + 1e-6) m.hd = headingOf(a, b);
    else if (m.f < prev - 1e-6) m.hd = headingOf(b, a);
    // home: back in the bay
    if (m.status === 'ready' && m.f <= 1e-4) { m.route = null; return false; }
    // still easing, or still driving toward a bound it has not reached (paused sim: it stops at the lead)
    return m.f !== ft || (m.dir !== 0 && ft !== (m.dir > 0 ? m.hi : m.lo));
  }
  const [bx, by] = bay(m.slot);
  const k = 1 - Math.exp(-dt / SMOOTH);
  m.x += (bx - m.x) * k;
  m.y += (by - m.y) * k;
  if (Math.hypot(bx - m.x, by - m.y) < 0.05) { m.x = bx; m.y = by; return false; }
  return true;
}

function paint(m: Motion, el: SVGGElement | null | undefined) {
  if (!el) return;
  const [sx, sy] = project(m.x, m.y);
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

interface Props {
  units: Unit[];
  buildings: Building[];
  /** real seconds per server tick (live 1.0, mock 0.7); refined from the countdown as ticks arrive */
  tickSeconds: number;
  pack: Pack;
  layer: 'under' | 'over';
  lite?: boolean;
  rotation?: number;
}

/**
 * Fire units in two layers: 'under' (the engines themselves, drawn below the buildings so a building in
 * front hides them) and 'over' (hoses and mist, which must stay visible above the buildings).
 */
export function FireUnits({ units, buildings, tickSeconds, pack, layer, lite = false, rotation = 0 }: Props) {
  if (layer === 'over') return <Hoses units={units} buildings={buildings} lite={lite} />;
  return <Engines units={units} buildings={buildings} tickSeconds={tickSeconds} pack={pack} rotation={rotation} />;
}

function Engines({ units, buildings, tickSeconds, pack, rotation }: { units: Unit[]; buildings: Building[]; tickSeconds: number; pack: Pack; rotation: number }) {
  const motions = useRef(new Map<number, Motion>());
  const els = useRef(new Map<number, SVGGElement>());
  const raf = useRef(0);
  const last = useRef(0);
  const look = vehLook(pack);
  const order = [...units].sort((a, b) => a.id - b.id);

  const loop = useRef<(now: number) => void>(() => {});
  useLayoutEffect(() => {
    loop.current = (now: number) => {
      const dt = Math.min(0.1, Math.max(0.001, (now - (last.current || now)) / 1000));
      last.current = now;
      let busy = false;
      for (const [id, m] of motions.current) {
        if (step(m, now, dt)) busy = true;
        paint(m, els.current.get(id));
      }
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
      if (!raf.current) step(m, now, 0.001);
      paint(m, els.current.get(u.id));
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

/** Water on the building once an engine is on scene: fades in as the engine settles at the curb. */
function Hoses({ units, buildings, lite }: { units: Unit[]; buildings: Building[]; lite: boolean }) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      {units.filter((u) => u.status === 'onscene').map((u) => {
        const b = buildings.find((x) => x.id === u.targetId);
        if (!b) return null;
        const { x, y, hd } = enginePark(b, buildings);
        const [ex, ey] = project(x, y);
        const [nx, ny] = vehOffset(hd, -6, 13);
        const [rx, ry] = project(b.x + b.w / 2, b.y + b.h / 2, SPRITE[b.kind].roof * spriteScale(b));
        const sx = ex + nx;
        const sy = ey + ny;
        const cy = Math.min(sy, ry) - 40;
        return (
          <g key={`s${u.id}-${b.id}`} className="hose-in">
            {[0, 1].map((k) => (
              <HoseStream key={k} sx={sx} sy={sy} tx={rx + (k ? 16 : -12)} ty={ry + (k ? 4 : -2)} lift={(cy - Math.min(sy, ry)) + (k ? -6 : 0)} seed={u.id * 2 + k} lite={lite} />
            ))}
          </g>
        );
      })}
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

