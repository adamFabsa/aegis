// Map markers and street life. Deliberately no pills/badges: buildings get a slim waypoint
// (stem + numbered diamond) with map-style halo lettering, and the streets get people and cars.
import { useEffect, useRef, type CSSProperties } from 'react';
import type { Building, Pack, Sim } from './types';
import { PeopleDefs, RouteVehicle, VehicleSprite } from './vehicles';
import { TRAFFIC, enginePark, headingOf, personStyle, vehLook, vehOffset, type Heading } from './vehicleData';
import { depthOf, project } from './iso';
import { SPRITE, STAGING, evacRoute, spriteScale, unitRoute } from './scene';
import type { Unit } from './mockWorld';
import { STATUS_COLORS } from './palettes';

type IconName = 'shield' | 'alert' | 'flame' | 'walk' | 'check' | 'x' | 'house';

const ICON_PATHS: Record<IconName, string> = {
  shield: 'M12 3l7 3v5c0 4.5-3 7.5-7 9.5C8 18.5 5 15.5 5 11V6z M9 12l2 2 4-4',
  alert: 'M12 4L21 20H3z M12 10v4 M12 17h.01',
  flame: 'M12 3c.5 3 4.5 5 4.5 10a4.5 4.5 0 0 1-9 0c0-2.5 1.5-3.5 1.8-6 1.6 1 2.7 2.4 2.7 4.5',
  walk: 'M14 4.5h.01 M10 21l2.5-6 2.5 2.5V21 M12.5 15l1-6.5-3 1.5-1.5 3 M13.5 8.5l2 3 3 1',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  house: 'M4 11l8-7 8 7v9H4z M10 20v-5h4v5',
};

function fmtMin(m: number): string {
  if (m < 0 || !Number.isFinite(m)) return 'no path';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}

interface MarkerInfo { color: string; line: string; icon: IconName | null; badge: string }

function markerInfo(b: Building, phase: Sim['phase']): MarkerInfo {
  const badge = b.kind === 'shelter' ? 'A' : b.kind === 'homes' ? 'H' : (b.name.match(/\d+/) ?? [''])[0];
  if (b.kind === 'shelter') return { badge, color: STATUS_COLORS.green, line: 'Shelter', icon: 'house' };
  switch (b.status) {
    case 'burning': return { badge, color: STATUS_COLORS.red, line: (b.damage ?? 0) >= 2 ? 'Gutted' : 'Burning', icon: 'flame' };
    case 'lost': return { badge, color: STATUS_COLORS.gray, line: 'Collapsed', icon: 'x' };
    case 'clear': return { badge, color: STATUS_COLORS.green, line: 'All out', icon: 'check' };
    case 'evacuating': return { badge, color: STATUS_COLORS.amber, line: `${b.peopleOut}/${b.residents} out`, icon: 'walk' };
    case 'behind': return { badge, color: STATUS_COLORS.red, line: `Behind · fire ${fmtMin(b.fireEtaMin)}`, icon: 'alert' };
  }
  if (phase === 'prep') {
    if (b.prepared) return { badge, color: STATUS_COLORS.green, line: 'Prepared', icon: 'shield' };
    const r = Math.round(b.risk);
    return { badge, color: r >= 70 ? STATUS_COLORS.red : r >= 40 ? STATUS_COLORS.amber : STATUS_COLORS.green, line: `Risk ${r}`, icon: null };
  }
  return { badge, color: '#9AA6BA', line: b.fireEtaMin >= 0 ? `Fire in ${fmtMin(b.fireEtaMin)}` : 'No fire path', icon: null };
}

interface Placed { b: Building; info: MarkerInfo; x: number; y: number; roofY: number; w: number }

/** Front buildings keep their spot; markers behind them slide up their stem until clear. */
function layout(buildings: Building[], phase: Sim['phase'], s: number): Placed[] {
  const order = [...buildings].sort((a, b) => depthOf(b.x + b.w / 2, b.y + b.h / 2) - depthOf(a.x + a.w / 2, a.y + a.h / 2));
  const out: Placed[] = [];
  for (const b of order) {
    const info = markerInfo(b, phase);
    const [x, roofY] = project(b.x + b.w / 2, b.y + b.h / 2, (SPRITE[b.kind].tag - 6) * spriteScale(b));
    const w = 26 + Math.max(b.name.length * 7.4, info.line.length * 6.4 + (info.icon ? 15 : 0));
    let y = roofY - 34 * s;
    for (let i = 0; i < 14; i++) {
      const hit = out.find((p) => x - 16 * s < p.x + p.w * s && p.x - 16 * s < x + w * s && Math.abs(p.y - y) < 36 * s);
      if (!hit) break;
      y = hit.y - 38 * s;
    }
    out.push({ b, info, x, y, roofY, w });
  }
  return out;
}

const HALO = { stroke: 'rgba(7,10,16,0.82)', strokeWidth: 3, paintOrder: 'stroke' as const, strokeLinejoin: 'round' as const };

export function Markers({ buildings, phase, scale, selectedId }: { buildings: Building[]; phase: Sim['phase']; scale: number; selectedId: number | null }) {
  return (
    <g style={{ pointerEvents: 'none' }} fontFamily="Inter, system-ui, sans-serif">
      {layout(buildings, phase, scale).map(({ b, info, x, y, roofY }) => {
        const sel = selectedId === b.id;
        return (
          <g key={b.id}>
            <line x1={x} y1={roofY} x2={x} y2={y + 15 * scale} stroke={info.color} strokeWidth={1.4 * scale} opacity="0.75" />
            <circle cx={x} cy={roofY} r={2.6 * scale} fill={info.color} />
            <g transform={`translate(${x} ${y}) scale(${scale})`}>
              {sel && (
                <rect x="-15" y="-15" width="30" height="30" rx="5" transform="rotate(45)" fill="none" stroke={info.color} strokeWidth="1.2" opacity="0.6">
                  <animate attributeName="opacity" values="0.7;0.15;0.7" dur="1.8s" repeatCount="indefinite" />
                </rect>
              )}
              <rect x="-11" y="-11" width="22" height="22" rx="4" transform="rotate(45)" fill={sel ? info.color : 'rgba(10,13,20,0.94)'} stroke={info.color} strokeWidth="2" />
              <text x="0" y="4" textAnchor="middle" fontSize="11.5" fontWeight="800" fill={sel ? '#0B0F17' : '#F5F7FB'}>{info.badge}</text>
              <text x="22" y="-2" fontSize="12.5" fontWeight="700" fill="#F5F7FB" {...HALO}>{b.name}</text>
              {info.icon && (
                <path d={ICON_PATHS[info.icon]} transform="translate(21 4) scale(0.52)" fill="none" stroke={info.color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              )}
              <text x={info.icon ? 36 : 22} y="13" fontSize="11" fontWeight="600" fill={info.color} {...HALO}>{info.line}</text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------ street life
function pathOf(pts: [number, number][]): string {
  return 'M' + pts.map(([x, y]) => { const [sx, sy] = project(x, y); return `${sx.toFixed(1)} ${sy.toFixed(1)}`; }).join(' L');
}

function pathLen(pts: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = project(...pts[i - 1]);
    const [bx, by] = project(...pts[i]);
    len += Math.hypot(bx - ax, by - ay);
  }
  return len;
}

const SIDEWALK_LOOPS: [number, number][][] = [
  [[30, 427], [960, 427], [30, 427]],
  [[980, 469], [60, 469], [980, 469]],
  [[357, 20], [357, 600], [357, 20]],
  [[395, 600], [395, 245], [980, 245], [395, 245], [395, 600]],
  [[180, 469], [700, 469], [180, 469]],
  [[395, 205], [395, 30], [395, 205]],
];
// right-hand traffic: each lane is one direction of travel
const LANES: [number, number][][] = [
  [[-30, 457], [1030, 457]],
  [[1030, 439], [-30, 439]],
  [[383, -30], [383, 650]],
  [[369, 650], [369, -30]],
  [[1025, 230], [392, 230], [369, 230], [369, -30]],
];

/** Point a fraction f of the way along a polyline (map space). */
function pointAt(pts: [number, number][], f: number): [number, number] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); total += d; }
  let t = (((f % 1) + 1) % 1) * total;
  for (let i = 0; i < seg.length; i++) {
    if (t <= seg[i]) { const u = t / seg[i]; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u]; }
    t -= seg[i];
  }
  return pts[pts.length - 1];
}

/** The rest of a polyline from fraction f onward. */
function restOf(pts: [number, number][], f: number): [number, number][] {
  const from = pointAt(pts, f);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let t = f * total;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (t <= d) return [from, ...pts.slice(i)];
    t -= d;
  }
  return [from, pts[pts.length - 1]];
}

/** Plays once when it mounts (fire just started): moves along d, then fades out and stays hidden. */
function OneShot({ href, style, d, dur }: { href: string; style: CSSProperties; d: string; dur: number }) {
  const motion = useRef<SVGAnimationElement>(null);
  const fade = useRef<SVGAnimationElement>(null);
  useEffect(() => {
    try { motion.current?.beginElement(); fade.current?.beginElement(); } catch { /* SMIL unavailable: element simply stays hidden */ }
  }, []);
  return (
    <use href={href} style={style} opacity="0">
      <animateMotion ref={motion} path={d} dur={`${dur}s`} begin="indefinite" fill="freeze" />
      <animate ref={fade} attributeName="opacity" values="1;1;0" keyTimes="0;0.85;1" dur={`${dur}s`} begin="indefinite" fill="freeze" />
    </use>
  );
}

/** Amber beacon on an evacuation van's roof. */
const vanBeacon = (hd: Heading) => {
  const [bx, by] = vehOffset(hd, 0, 11.4);
  return (
    <circle cx={bx} cy={by} r="5" fill="url(#vanGlow)">
      <animate attributeName="opacity" values="1;0.15;1" dur="0.8s" repeatCount="indefinite" />
    </circle>
  );
};

export function StreetLife({ buildings, phase, pack }: { buildings: Building[]; phase: Sim['phase']; pack: Pack }) {
  const shelter = buildings.find((b) => b.kind === 'shelter');
  const evacuating = buildings.filter((b) => b.status === 'evacuating');
  const look = vehLook(pack);
  return (
    <g style={{ pointerEvents: 'none' }}>
      <PeopleDefs />
      <defs>
        <radialGradient id="vanGlow"><stop offset="0" stopColor="#FFC24A" stopOpacity="0.95" /><stop offset="1" stopColor="#FFB020" stopOpacity="0" /></radialGradient>
      </defs>

      {/* fire: drivers clear the roads, people on the street run for the nearest door and disappear inside */}
      {phase !== 'prep' && LANES.flatMap((lane, li) => [0, 1].map((k) => {
        const route = restOf(lane, ((k * 0.5 + li * 0.21) % 1) * 0.75);
        return <RouteVehicle key={`fc${li}${k}`} route={route} model={TRAFFIC[(li * 2 + k) % TRAFFIC.length]} look={look} dur={Math.max(1.8, pathLen(route) / 150)} once fade />;
      }))}
      {phase !== 'prep' && SIDEWALK_LOOPS.flatMap((loop, li) => [0, 1].map((k) => {
        const from = pointAt(loop, (k * 0.5 + li * 0.13) % 1);
        const doors = buildings.filter((b) => b.status !== 'lost' && b.status !== 'burning').map((b) => [b.x + b.w / 2, b.y + b.h + 2] as [number, number]);
        const to = doors.reduce((best, p) => (Math.hypot(p[0] - from[0], p[1] - from[1]) < Math.hypot(best[0] - from[0], best[1] - from[1]) ? p : best), doors[0] ?? from);
        return <OneShot key={`fp${li}${k}`} href="#pedRun" style={personStyle(li * 2 + k)} d={pathOf([from, to])} dur={Math.max(1.6, pathLen([from, to]) / 46)} />;
      }))}

      {/* everyday traffic while the town is preparing */}
      {phase === 'prep' && LANES.flatMap((lane, li) => {
        const dur = pathLen(lane) / 34;
        return [0, 1].map((k) => (
          <RouteVehicle key={`c${li}${k}`} route={lane} model={TRAFFIC[(li * 2 + k) % TRAFFIC.length]} look={look} dur={dur} begin={(k * dur) / 2 + li * 3} />
        ));
      })}

      {/* residents out for a walk while the town is preparing */}
      {phase === 'prep' && SIDEWALK_LOOPS.flatMap((loop, li) => {
        const d = pathOf(loop);
        const dur = pathLen(loop) / 9;
        return [0, 1].map((k) => (
          <use key={`w${li}${k}`} href="#ped" style={personStyle(li * 2 + k)}>
            <animateMotion path={d} dur={`${dur}s`} begin={`${-((k * 0.5 + li * 0.13) % 1) * dur}s`} repeatCount="indefinite" />
          </use>
        ));
      })}

      {/* evacuations: residents walk out in a column, those who need help go in wheelchairs pushed by staff, vans shuttle */}
      {evacuating.map((b) => {
        const route = evacRoute(b, shelter);
        const d = pathOf(route);
        const len = pathLen(route);
        const walk = Math.max(8, len / 12);
        const drive = Math.max(4, len / 40);
        const n = 10;
        const chairs = Math.min(3, Math.max(1, Math.round((b.needsHelp / Math.max(1, b.residents)) * n)));
        return (
          <g key={`e${b.id}`}>
            {Array.from({ length: n }, (_, i) => (
              <use key={i} href={i % Math.ceil(n / chairs) === 2 ? '#pedChair' : '#ped'} style={personStyle(b.id * 3 + i)}>
                <animateMotion path={d} dur={`${walk}s`} begin={`${(-i * walk) / n}s`} repeatCount="indefinite" />
              </use>
            ))}
            {Array.from({ length: Math.max(1, b.vans) }, (_, i) => (
              <RouteVehicle key={`v${i}`} route={route} model="van" look={look} dur={drive} begin={(i * drive) / Math.max(1, b.vans)} overlay={vanBeacon} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------ fire units (incident command)
/** Red and blue light bar on an engine's cab roof, flashing. */
const lightBar = (hd: Heading) => {
  const [lx, ly] = vehOffset(hd, 12.2, 12.8);
  return (
    <g>
      <circle cx={lx} cy={ly} r="11" fill="url(#beacon)"><animate attributeName="opacity" values="0.7;0.1;0.7" dur="0.5s" repeatCount="indefinite" /></circle>
      <circle cx={lx - 1.2} cy={ly} r="1.1" fill="#FF3B30"><animate attributeName="opacity" values="1;0.15;1" dur="0.5s" repeatCount="indefinite" /></circle>
      <circle cx={lx + 1.2} cy={ly + 0.4} r="1.1" fill="#4C8DFF"><animate attributeName="opacity" values="0.15;1;0.15" dur="0.5s" repeatCount="indefinite" /></circle>
    </g>
  );
};

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

/** Parked engine sprite, depth-sorted with the buildings by Town. */
export function ParkedEngine({ b, all, pack }: { b: Building; all: Building[]; pack: Pack }) {
  const { x, y, hd } = enginePark(b, all);
  const [ex, ey] = project(x, y);
  return <VehicleSprite model="engine" hd={hd} look={vehLook(pack)} x={ex} y={ey} />;
}

/**
 * Fire units in two layers: 'under' (engines at staging and on the road, drawn below the buildings so
 * a building in front hides them) and 'over' (light bars, hoses and mist, which must stay visible).
 */
export function FireUnits({ units, buildings, tickSeconds, pack, layer, lite = false }: { units: Unit[]; buildings: Building[]; tickSeconds: number; pack: Pack; layer: 'under' | 'over'; lite?: boolean }) {
  const ready = units.filter((u) => u.status === 'ready');
  const look = vehLook(pack);
  if (layer === 'under') {
    return (
      <g style={{ pointerEvents: 'none' }}>
        <defs>
          <radialGradient id="beacon"><stop offset="0" stopColor="#FF5A4E" stopOpacity="0.8" /><stop offset="1" stopColor="#FF5A4E" stopOpacity="0" /></radialGradient>
          <radialGradient id="mist"><stop offset="0" stopColor="#E4F5FF" stopOpacity="0.75" /><stop offset="0.6" stopColor="#CFEFFF" stopOpacity="0.3" /><stop offset="1" stopColor="#CFEFFF" stopOpacity="0" /></radialGradient>
          <linearGradient id="jet" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#FFFFFF" /><stop offset="0.7" stopColor="#CDEBFF" /><stop offset="1" stopColor="#A9DEFF" stopOpacity="0.6" /></linearGradient>
        </defs>
        {/* engines parked side by side at the staging lot, noses toward the street */}
        {ready.map((u, i) => {
          const [x, y] = project(STAGING[0] - 28 + i * 28, STAGING[1] + 26);
          return <VehicleSprite key={`r${u.id}`} model="engine" hd={headingOf([0, 0], [0, -1])} look={look} x={x} y={y} />;
        })}
        {/* driving back: the route in reverse, light bar off */}
        {units.filter((u) => u.status === 'returning').map((u) => {
          const b = buildings.find((x) => x.id === u.targetId);
          if (!b) return null;
          return <RouteVehicle key={`b${u.id}-${b.id}-${u.travelTicks}`} route={[...unitRoute(b, buildings)].reverse()} model="engine" look={look} dur={u.travelTicks * tickSeconds} once />;
        })}
        {units.filter((u) => u.status === 'enroute').map((u) => {
          const b = buildings.find((x) => x.id === u.targetId);
          if (!b) return null;
          return <RouteVehicle key={`m${u.id}-${b.id}`} route={unitRoute(b, buildings)} model="engine" look={look} dur={u.travelTicks * tickSeconds} once overlay={lightBar} />;
        })}
      </g>
    );
  }
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
          <g key={`s${u.id}`}>
            <g transform={`translate(${ex} ${ey})`}>{lightBar(hd)}</g>
            {[0, 1].map((k) => (
              <HoseStream key={k} sx={sx} sy={sy} tx={rx + (k ? 16 : -12)} ty={ry + (k ? 4 : -2)} lift={(cy - Math.min(sy, ry)) + (k ? -6 : 0)} seed={u.id * 2 + k} lite={lite} />
            ))}
          </g>
        );
      })}
    </g>
  );
}
