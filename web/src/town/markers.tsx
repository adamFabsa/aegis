// Map markers and street life. Deliberately no pills/badges: buildings get a slim waypoint
// (stem + numbered diamond) with map-style halo lettering, and the streets get people and cars.
import { useEffect, useRef, type CSSProperties } from 'react';
import type { Building, Pack, Sim } from './types';
import { PeopleDefs, RouteVehicle } from './vehicles';
import { TRAFFIC, personStyle, vehLook, vehOffset, type Heading } from './vehicleData';
import { depthOf, project } from './iso';
import { SPRITE, evacRoute, spriteScale } from './scene';
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

/**
 * `fadeFrom`: the look and phase the map just left. While it fades, the everyday traffic of the prep
 * phase keeps driving and dissolves instead of vanishing the moment the fire starts.
 */
export function StreetLife({ buildings, phase, pack, fadeFrom }: { buildings: Building[]; phase: Sim['phase']; pack: Pack; fadeFrom?: { phase: Sim['phase']; pack: Pack; epoch: number } | null }) {
  const shelter = buildings.find((b) => b.kind === 'shelter');
  const evacuating = buildings.filter((b) => b.status === 'evacuating');
  const look = vehLook(pack);
  const prepLeaving = phase !== 'prep' && fadeFrom?.phase === 'prep';
  const prepLook = prepLeaving ? vehLook(fadeFrom.pack) : look;
  return (
    <g style={{ pointerEvents: 'none' }}>
      <PeopleDefs />
      <defs>
        <radialGradient id="vanGlow"><stop offset="0" stopColor="#FFC24A" stopOpacity="0.95" /><stop offset="1" stopColor="#FFB020" stopOpacity="0" /></radialGradient>
      </defs>

      {/* fire: drivers clear the roads, people on the street run for the nearest door and disappear inside */}
      {phase !== 'prep' && (
        <g className="fx-in">
          {LANES.flatMap((lane, li) => [0, 1].map((k) => {
            const route = restOf(lane, ((k * 0.5 + li * 0.21) % 1) * 0.75);
            return <RouteVehicle key={`fc${li}${k}`} route={route} model={TRAFFIC[(li * 2 + k) % TRAFFIC.length]} look={look} dur={Math.max(1.8, pathLen(route) / 150)} once fade />;
          }))}
          {SIDEWALK_LOOPS.flatMap((loop, li) => [0, 1].map((k) => {
            const from = pointAt(loop, (k * 0.5 + li * 0.13) % 1);
            const doors = buildings.filter((b) => b.status !== 'lost' && b.status !== 'burning').map((b) => [b.x + b.w / 2, b.y + b.h + 2] as [number, number]);
            const to = doors.reduce((best, p) => (Math.hypot(p[0] - from[0], p[1] - from[1]) < Math.hypot(best[0] - from[0], best[1] - from[1]) ? p : best), doors[0] ?? from);
            return <OneShot key={`fp${li}${k}`} href="#pedRun" style={personStyle(li * 2 + k)} d={pathOf([from, to])} dur={Math.max(1.6, pathLen([from, to]) / 46)} />;
          }))}
        </g>
      )}

      {/* everyday traffic and residents out for a walk while the town is preparing
          (SMIL runs on the document clock, so the cars keep their places across the remount) */}
      {(phase === 'prep' || prepLeaving) && (
        <g key={prepLeaving ? `out${fadeFrom.epoch}` : 'prep'} className={prepLeaving ? 'pack-out' : 'fx-in'}>
          {LANES.flatMap((lane, li) => {
            const dur = pathLen(lane) / 34;
            return [0, 1].map((k) => (
              <RouteVehicle key={`c${li}${k}`} route={lane} model={TRAFFIC[(li * 2 + k) % TRAFFIC.length]} look={prepLook} dur={dur} begin={(k * dur) / 2 + li * 3} />
            ));
          })}
          {SIDEWALK_LOOPS.flatMap((loop, li) => {
            const d = pathOf(loop);
            const dur = pathLen(loop) / 9;
            return [0, 1].map((k) => (
              <use key={`w${li}${k}`} href="#ped" style={personStyle(li * 2 + k)}>
                <animateMotion path={d} dur={`${dur}s`} begin={`${-((k * 0.5 + li * 0.13) % 1) * dur}s`} repeatCount="indefinite" />
              </use>
            ));
          })}
        </g>
      )}

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

