// Map markers and street life. Deliberately no pills/badges: buildings get a slim waypoint
// (stem + numbered diamond) with map-style halo lettering, and the streets get people and cars.
import { useEffect, useRef } from 'react';
import type { Building, Sim } from './types';
import { project } from './iso';
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
  const order = [...buildings].sort((a, b) => b.x + b.w / 2 + b.y + b.h / 2 - (a.x + a.w / 2 + a.y + a.h / 2));
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
const SHIRTS = ['#E8E2D6', '#5B8DEF', '#D9534F', '#F0B429', '#7BC47F', '#B48EF0', '#3FB4C8', '#E78F4E'];

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
const LANES: [number, number][][] = [
  [[-10, 457], [1010, 457]],
  [[1010, 439], [-10, 439]],
  [[383, -10], [383, 630]],
  [[369, 630], [369, -10]],
  [[1005, 230], [392, 230]],
];
const CAR_COLORS = ['#C9CED6', '#8C2F2F', '#2F4C7A', '#E8E6E0', '#3B4A3F', '#6B6F78'];

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

/** Plays once when it mounts (fire just started): moves along d, then fades out and stays hidden. */
function OneShot({ href, color, d, dur }: { href: string; color?: string; d: string; dur: number }) {
  const motion = useRef<SVGAnimationElement>(null);
  const fade = useRef<SVGAnimationElement>(null);
  useEffect(() => {
    try { motion.current?.beginElement(); fade.current?.beginElement(); } catch { /* SMIL unavailable: element simply stays hidden */ }
  }, []);
  return (
    <use href={href} color={color} opacity="0">
      <animateMotion ref={motion} path={d} dur={`${dur}s`} begin="indefinite" fill="freeze" />
      <animate ref={fade} attributeName="opacity" values="1;1;0" keyTimes="0;0.85;1" dur={`${dur}s`} begin="indefinite" fill="freeze" />
    </use>
  );
}

export function StreetLife({ buildings, phase }: { buildings: Building[]; phase: Sim['phase'] }) {
  const shelter = buildings.find((b) => b.kind === 'shelter');
  const evacuating = buildings.filter((b) => b.status === 'evacuating');
  return (
    <g style={{ pointerEvents: 'none' }}>
      <defs>
        {/* a resident: shirt takes the `color` of the <use>, legs swing while walking */}
        <g id="ped">
          <ellipse cx="0.6" cy="0" rx="2.2" ry="0.8" fill="#000" opacity="0.3" />
          <line x1="0" y1="-3.6" x2="0" y2="0" stroke="#232838" strokeWidth="1.1" strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" values="-22 0 -3.6;22 0 -3.6;-22 0 -3.6" dur="0.55s" repeatCount="indefinite" />
          </line>
          <line x1="0" y1="-3.6" x2="0" y2="0" stroke="#2E3446" strokeWidth="1.1" strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" values="22 0 -3.6;-22 0 -3.6;22 0 -3.6" dur="0.55s" repeatCount="indefinite" />
          </line>
          <rect x="-1.5" y="-7.8" width="3" height="4.6" rx="1.2" fill="currentColor" />
          <circle cx="0" cy="-9.3" r="1.45" fill="#E2B892" />
        </g>
        {/* running: faster stride, leaning forward */}
        <g id="pedRun">
          <ellipse cx="0.6" cy="0" rx="2.2" ry="0.8" fill="#000" opacity="0.3" />
          <g transform="rotate(-12 0 0)">
            <line x1="0" y1="-3.6" x2="0" y2="0" stroke="#232838" strokeWidth="1.2" strokeLinecap="round">
              <animateTransform attributeName="transform" type="rotate" values="-38 0 -3.6;38 0 -3.6;-38 0 -3.6" dur="0.28s" repeatCount="indefinite" />
            </line>
            <line x1="0" y1="-3.6" x2="0" y2="0" stroke="#2E3446" strokeWidth="1.2" strokeLinecap="round">
              <animateTransform attributeName="transform" type="rotate" values="38 0 -3.6;-38 0 -3.6;38 0 -3.6" dur="0.28s" repeatCount="indefinite" />
            </line>
            <rect x="-1.5" y="-7.8" width="3" height="4.6" rx="1.2" fill="currentColor" />
            <circle cx="0" cy="-9.3" r="1.45" fill="#E2B892" />
          </g>
        </g>
        <g id="car">
          <ellipse cx="1" cy="0.5" rx="7" ry="2" fill="#000" opacity="0.3" />
          <rect x="-6.5" y="-4.6" width="13" height="4.4" rx="1.6" fill="currentColor" />
          <rect x="-3.6" y="-7.4" width="7.4" height="3.2" rx="1.2" fill="#1B2433" />
          <rect x="-3.2" y="-7.1" width="2.6" height="2.4" rx="0.6" fill="#7FA3C4" opacity="0.6" />
          <circle cx="-3.8" cy="-0.2" r="1.3" fill="#111" />
          <circle cx="3.8" cy="-0.2" r="1.3" fill="#111" />
        </g>
        <g id="van">
          <ellipse cx="1" cy="0.6" rx="9" ry="2.4" fill="#000" opacity="0.3" />
          <rect x="-8" y="-8.6" width="16" height="8.2" rx="2" fill="#F2F2EF" />
          <rect x="-6.6" y="-7.4" width="9" height="2.8" rx="0.6" fill="#1C2A36" />
          <rect x="-8" y="-3.6" width="16" height="1.2" fill="#F2A93B" />
          <rect x="-1.4" y="-10" width="2.8" height="1.4" rx="0.5" fill="#F2A93B">
            <animate attributeName="opacity" values="1;0.2;1" dur="0.7s" repeatCount="indefinite" />
          </rect>
          <circle cx="-4.6" cy="-0.3" r="1.5" fill="#111" />
          <circle cx="4.6" cy="-0.3" r="1.5" fill="#111" />
        </g>
      </defs>

      {/* fire: drivers clear the roads, people on the street run for the nearest door and disappear inside */}
      {phase !== 'prep' && LANES.flatMap((lane, li) => [0, 1].map((k) => {
        const from = pointAt(lane, ((k * 0.5 + li * 0.21) % 1) * 0.8);
        const d = pathOf([from, lane[lane.length - 1]]);
        return <OneShot key={`fc${li}${k}`} href="#car" color={CAR_COLORS[(li * 2 + k) % CAR_COLORS.length]} d={d} dur={Math.max(1.8, pathLen([from, lane[lane.length - 1]]) / 160)} />;
      }))}
      {phase !== 'prep' && SIDEWALK_LOOPS.flatMap((loop, li) => [0, 1].map((k) => {
        const from = pointAt(loop, (k * 0.5 + li * 0.13) % 1);
        const doors = buildings.filter((b) => b.status !== 'lost' && b.status !== 'burning').map((b) => [b.x + b.w / 2, b.y + b.h + 2] as [number, number]);
        const to = doors.reduce((best, p) => (Math.hypot(p[0] - from[0], p[1] - from[1]) < Math.hypot(best[0] - from[0], best[1] - from[1]) ? p : best), doors[0] ?? from);
        return <OneShot key={`fp${li}${k}`} href="#pedRun" color={SHIRTS[(li * 3 + k) % SHIRTS.length]} d={pathOf([from, to])} dur={Math.max(1.6, pathLen([from, to]) / 46)} />;
      }))}

      {/* everyday traffic while the town is preparing */}
      {phase === 'prep' && LANES.flatMap((lane, li) => {
        const d = pathOf(lane);
        const dur = pathLen(lane) / 34;
        return [0, 1].map((k) => (
          <use key={`c${li}${k}`} href="#car" color={CAR_COLORS[(li * 2 + k) % CAR_COLORS.length]}>
            <animateMotion path={d} dur={`${dur}s`} begin={`${-(k * dur) / 2 - li * 3}s`} repeatCount="indefinite" />
          </use>
        ));
      })}

      {/* residents out for a walk while the town is preparing */}
      {phase === 'prep' && SIDEWALK_LOOPS.flatMap((loop, li) => {
        const d = pathOf(loop);
        const dur = pathLen(loop) / 9;
        return [0, 1].map((k) => (
          <use key={`w${li}${k}`} href="#ped" color={SHIRTS[(li * 3 + k) % SHIRTS.length]}>
            <animateMotion path={d} dur={`${dur}s`} begin={`${-((k * 0.5 + li * 0.13) % 1) * dur}s`} repeatCount="indefinite" />
          </use>
        ));
      })}

      {/* evacuations: a column of residents (one being helped) and the building's vans */}
      {evacuating.map((b) => {
        const route = evacRoute(b, shelter);
        const d = pathOf(route);
        const len = pathLen(route);
        const walk = Math.max(8, len / 14);
        const drive = Math.max(4, len / 40);
        return (
          <g key={`e${b.id}`}>
            {Array.from({ length: 9 }, (_, i) => (
              <use key={i} href={i === 4 ? '#ped' : '#pedRun'} color={i === 4 ? STATUS_COLORS.amber : SHIRTS[i % SHIRTS.length]}>
                <animateMotion path={d} dur={`${walk}s`} begin={`${(-i * walk) / 9}s`} repeatCount="indefinite" />
              </use>
            ))}
            <use href="#ped" color={STATUS_COLORS.green}>
              <animateMotion path={d} dur={`${walk}s`} begin={`${(-4 * walk) / 9 + 0.35}s`} repeatCount="indefinite" />
            </use>
            {Array.from({ length: Math.max(1, b.vans) }, (_, i) => (
              <use key={`v${i}`} href="#van">
                <animateMotion path={d} dur={`${drive}s`} begin={`${(-i * drive) / Math.max(1, b.vans)}s`} repeatCount="indefinite" />
              </use>
            ))}
          </g>
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------ fire units (incident command)
function EngineDefs() {
  const body = (
    <>
      <ellipse cx="1" cy="0.6" rx="13" ry="3" fill="#000" opacity="0.35" />
      <rect x="-11" y="-9.4" width="22" height="9" rx="1.6" fill="#C8262B" />
      <rect x="4.6" y="-12.6" width="6.4" height="4.2" rx="1" fill="#C8262B" />
      <rect x="5.6" y="-12" width="4.4" height="2.6" rx="0.5" fill="#1C2A36" />
      <path d="M-10 -10.6 H3.6 M-8.6 -10.6 v-1.5 M-5.6 -10.6 v-1.5 M-2.6 -10.6 v-1.5 M0.4 -10.6 v-1.5 M-10 -12.1 H1.6" stroke="#E6E6E2" strokeWidth="0.8" fill="none" />
      <rect x="-11" y="-5" width="22" height="1.1" fill="#F2F2EF" />
      <circle cx="-6.6" cy="-0.3" r="1.7" fill="#111" />
      <circle cx="6.6" cy="-0.3" r="1.7" fill="#111" />
    </>
  );
  return (
    <defs>
      <g id="engine"><g transform="scale(1.6)">{body}</g></g>
      <g id="engineOn">
        <g transform="scale(1.6)">
        {body}
        <rect x="5.2" y="-14" width="2" height="1.4" rx="0.4" fill="#FF3B30"><animate attributeName="opacity" values="1;0.15;1" dur="0.5s" repeatCount="indefinite" /></rect>
        <rect x="8" y="-14" width="2" height="1.4" rx="0.4" fill="#4C8DFF"><animate attributeName="opacity" values="0.15;1;0.15" dur="0.5s" repeatCount="indefinite" /></rect>
        <circle cx="6.6" cy="-13.3" r="9" fill="url(#beacon)" opacity="0.5"><animate attributeName="opacity" values="0.6;0.1;0.6" dur="0.5s" repeatCount="indefinite" /></circle>
        </g>
      </g>
      <radialGradient id="beacon"><stop offset="0" stopColor="#FF5A4E" stopOpacity="0.8" /><stop offset="1" stopColor="#FF5A4E" stopOpacity="0" /></radialGradient>
      <radialGradient id="mist"><stop offset="0" stopColor="#CFEFFF" stopOpacity="0.7" /><stop offset="1" stopColor="#CFEFFF" stopOpacity="0" /></radialGradient>
    </defs>
  );
}

/** Drives once along the route when dispatched (mounts on dispatch, freezes at the building). */
function Responding({ d, dur }: { d: string; dur: number }) {
  const motion = useRef<SVGAnimationElement>(null);
  useEffect(() => {
    try { motion.current?.beginElement(); } catch { /* no SMIL: engine appears on scene when it arrives */ }
  }, []);
  return (
    <use href="#engineOn">
      <animateMotion ref={motion} path={d} dur={`${dur}s`} begin="indefinite" fill="freeze" />
    </use>
  );
}

export function FireUnits({ units, buildings, tickSeconds }: { units: Unit[]; buildings: Building[]; tickSeconds: number }) {
  const ready = units.filter((u) => u.status === 'ready');
  return (
    <g style={{ pointerEvents: 'none' }}>
      <EngineDefs />
      {ready.map((u, i) => {
        const [x, y] = project(STAGING[0] - 30 + i * 30, STAGING[1] + 30);
        return <use key={`r${u.id}`} href="#engine" x={x} y={y} />;
      })}
      {units.filter((u) => u.status !== 'ready').map((u) => {
        const b = buildings.find((x) => x.id === u.targetId);
        if (!b) return null;
        const route = unitRoute(b);
        if (u.status === 'enroute') return <Responding key={`m${u.id}-${b.id}`} d={pathOf(route)} dur={u.travelTicks * tickSeconds} />;
        const [ex, ey] = project(...route[route.length - 1]);
        const [rx, ry] = project(b.x + b.w / 2, b.y + b.h / 2, SPRITE[b.kind].roof * spriteScale(b));
        const cx = (ex + rx) / 2;
        const cy = Math.min(ey, ry) - 46;
        return (
          <g key={`s${u.id}`}>
            <use href="#engineOn" x={ex} y={ey} />
            {[0, 1].map((k) => (
              <path key={k} d={`M${ex + 8} ${ey - 21} Q ${cx + k * 10} ${cy - k * 8} ${rx + (k ? 14 : -10)} ${ry}`} stroke="#A9DEFF" strokeWidth={k ? 1.6 : 2.4} fill="none" strokeLinecap="round" strokeDasharray="5 7" opacity="0.85">
                <animate attributeName="stroke-dashoffset" from="24" to="0" dur={k ? '0.45s' : '0.6s'} repeatCount="indefinite" />
              </path>
            ))}
            <circle cx={rx} cy={ry} r="22" fill="url(#mist)">
              <animate attributeName="r" values="18;26;18" dur="1.4s" repeatCount="indefinite" />
            </circle>
          </g>
        );
      })}
    </g>
  );
}
