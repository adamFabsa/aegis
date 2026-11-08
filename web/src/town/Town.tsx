import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { Building, FireCell, Ghost, Pack, Sim } from './types';
import { CELL, MAP_H, MAP_W, VIEW_H, VIEW_W, depthOf, groundMatrix, pointsAttr, project, projectRaw, projectVec, rotRect, viewRotation, windScreen, windVector } from './iso';
import {
  GROUND_PLATE, LAMPS, groundUrl, PROP_BOX, SPRITE, SPRITE_BOX, propUrl,
  evacRoute, generatePlants, previousVariant, ridgePaths, spriteScale, spriteUrl, spriteVariant, type Plant,
} from './scene';
import { PALETTES, STATUS_COLORS, type GroundPalette } from './palettes';
import { IgnitionMarker, Markers, StreetLife } from './markers';
import { FireUnits } from './trucks';
import { WindStreaks } from './wind';
import { WindowLayer } from './WindowLayer';
import { ready } from './assets';
import { FireDefs } from './FireDefs';
import { TICK_SECONDS, type Unit } from './mockWorld';

interface TownProps {
  sim: Sim;
  buildings: Building[];
  fireCells: FireCell[];
  pack: Pack;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** MapView moves the camera by writing the viewBox straight onto this element (no React re-render). */
  svgRef?: Ref<SVGSVGElement>;
  /** Phones: skip noise textures, blur and blend modes that are expensive to re-rasterize while panning. */
  lite?: boolean;
  /** Screen-constant scale for status tags so they stay readable when zoomed out. */
  tagScale?: number;
  units?: Unit[];
  /** bumps when a tracked image finishes loading */
  assets?: number;
  /** view rotation (0..3); the projection reads it from iso.ts, this prop just re-renders the town */
  rotation?: number;
  /** the look/phase the map just left: dissolved over the new frame for a moment (see MapView useGhost) */
  ghost?: Ghost | null;
  /** real seconds per server tick, for the fire engines' driving speed */
  tickSeconds?: number;
  /** trees and brush scatter (7 = the demo map; scenarios pass their number) */
  plantSeed?: number;
  /** where the fire will start (map units): marked on the ground before the fire */
  ignition?: { x: number; y: number; picked: boolean } | null;
  /** picking the fire start: a click on the ground reports its map point instead of selecting */
  onPick?: (x: number, y: number) => void;
}

/** True while `on`, and for `ms` after it turns off (so a layer can fade out instead of popping). */
function useLinger(on: boolean, ms: number): boolean {
  const [linger, setLinger] = useState(false);
  const [was, setWas] = useState(on);
  if (was !== on) {
    setWas(on);
    if (!on) setLinger(true);
  }
  useEffect(() => {
    if (!linger) return;
    const t = setTimeout(() => setLinger(false), ms);
    return () => clearTimeout(t);
  }, [linger, ms]);
  return on || linger;
}

/** The value a change just replaced, for `ms` (so the old one can dissolve while the new one fades in). */
function useOutgoing<T>(value: T, ms: number): T | null {
  const [out, setOut] = useState<T | null>(null);
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setOut(was);
  }
  useEffect(() => {
    if (out === null) return;
    const t = setTimeout(() => setOut(null), ms);
    return () => clearTimeout(t);
  }, [out, ms]);
  return out;
}

const plantKey = (p: Plant) => `${Math.round(p.x)}_${Math.round(p.y)}_${p.type}`;

const cellKey = (x: number, y: number) => y * 1000 + x;
function stateMap(cells: FireCell[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cells) if (c.state) m.set(cellKey(c.x, c.y), c.state);
  return m;
}

const FLAMES = ['fireA', 'fireB', 'fireC'];
const RIDGES = ridgePaths();

function Defs({ P }: { P: GroundPalette }) {
  return (
    <defs>
      <filter id="grain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves={2} seed={9} result="n" />
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.4 1.45" result="a" />
        <feComposite in="a" in2="SourceGraphic" operator="in" />
      </filter>
      <filter id="blur2" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.2" /></filter>
      <filter id="blur4" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4" /></filter>
      <filter id="blur8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7" /></filter>
      <filter id="blur20" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="20" /></filter>
      {/* low-frequency terrain patches: darker and lighter blotches so the ground is not one flat colour */}
      <filter id="patches" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves={3} seed={4} result="n" />
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -3.2 1.75" result="a" />
        <feComposite in="a" in2="SourceGraphic" operator="in" />
      </filter>
      <filter id="patchesHi" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves={2} seed={21} result="n" />
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 3.2 -1.85" result="a" />
        <feComposite in="a" in2="SourceGraphic" operator="in" />
      </filter>
      <pattern id="ash" width="22" height="18" patternUnits="userSpaceOnUse">
        <rect width="22" height="18" fill={P.char} />
        <circle cx="4" cy="5" r="2.2" fill="#000" opacity="0.35" />
        <circle cx="15" cy="12" r="3" fill="#000" opacity="0.3" />
        <circle cx="12" cy="3" r="1.2" fill="#8A817A" opacity="0.35" />
        <circle cx="19" cy="7" r="0.9" fill="#8A817A" opacity="0.3" />
        <circle cx="7" cy="14" r="0.8" fill="#FF6A2A" opacity="0.75" />
        <circle cx="18" cy="16" r="0.6" fill="#FF8A3D" opacity="0.6" />
      </pattern>
      <linearGradient id="slabShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.1" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.35" />
      </linearGradient>
      <radialGradient id="lamp">
        <stop offset="0" stopColor="#FFD69A" stopOpacity="0.55" />
        <stop offset="1" stopColor="#FFD69A" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="groundGlow">
        <stop offset="0" stopColor="#FF7A2E" stopOpacity="0.55" />
        <stop offset="0.5" stopColor="#FF5A1F" stopOpacity="0.18" />
        <stop offset="1" stopColor="#FF5A1F" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="fireGlow">
        <stop offset="0" stopColor="#FF8A3D" stopOpacity="0.55" />
        <stop offset="0.45" stopColor="#FF5A1F" stopOpacity="0.18" />
        <stop offset="1" stopColor="#FF5A1F" stopOpacity="0" />
      </radialGradient>
      {/* smoke puffs are soft radial gradients: same look as a blur filter at a fraction of the cost */}
      <radialGradient id="smokePlume"><stop offset="0" stopColor={P.smoke} stopOpacity="0.9" /><stop offset="0.55" stopColor={P.smoke} stopOpacity="0.45" /><stop offset="1" stopColor={P.smoke} stopOpacity="0" /></radialGradient>
      <radialGradient id="smokeDark"><stop offset="0" stopColor="#2A2627" stopOpacity="0.95" /><stop offset="0.6" stopColor="#2A2627" stopOpacity="0.4" /><stop offset="1" stopColor="#2A2627" stopOpacity="0" /></radialGradient>
      <radialGradient id="smokeGray"><stop offset="0" stopColor="#6B6460" stopOpacity="0.9" /><stop offset="0.6" stopColor="#6B6460" stopOpacity="0.35" /><stop offset="1" stopColor="#6B6460" stopOpacity="0" /></radialGradient>
      {/* fire inside a room: white-hot at the sill, deep red at the head; bands roll upward */}
      <linearGradient id="winFire" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#FFE9A8" />
        <stop offset="0.35" stopColor="#FF9A2E" />
        <stop offset="0.75" stopColor="#E2470F" />
        <stop offset="1" stopColor="#7A1A08" />
      </linearGradient>
      <linearGradient id="winWave" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#FFD27A" stopOpacity="0" />
        <stop offset="0.2" stopColor="#FFD27A" stopOpacity="0.9">
          <animate attributeName="offset" values="0;0.85;0" dur="1.1s" repeatCount="indefinite" />
        </stop>
        <stop offset="0.4" stopColor="#FF6A1F" stopOpacity="0">
          <animate attributeName="offset" values="0.2;1;0.2" dur="1.1s" repeatCount="indefinite" />
        </stop>
      </linearGradient>
      <FireDefs />
      <radialGradient id="roofGlow">
        <stop offset="0" stopColor="#FF8A3D" stopOpacity="0.75" />
        <stop offset="0.5" stopColor="#FF5A1F" stopOpacity="0.28" />
        <stop offset="1" stopColor="#FF5A1F" stopOpacity="0" />
      </radialGradient>
      <g id="oak">
        <ellipse cx="4" cy="1" rx="12" ry="4" fill="#000" opacity="0.22" />
        <rect x="-1.3" y="-11" width="2.6" height="11" fill={P.trunk} />
        <circle cx="0" cy="-17" r="9.5" fill={P.canD} />
        <circle cx="-3" cy="-19" r="7.2" fill={P.can} />
        <circle cx="3.5" cy="-21" r="5.4" fill={P.canHi} />
      </g>
      <g id="palm">
        <ellipse cx="6" cy="1" rx="10" ry="3" fill="#000" opacity="0.2" />
        <path d="M0 0 Q2 -16 -1 -34" stroke={P.trunk} strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <path d="M-1 -34 q-9 -1 -14 6 M-1 -34 q9 -2 14 5 M-1 -34 q-5 -7 -12 -8 M-1 -34 q6 -7 12 -6 M-1 -34 q1 -6 0 -10 M-1 -34 q-3 4 -6 9 M-1 -34 q4 3 6 9" stroke={P.palm} strokeWidth="2.4" fill="none" strokeLinecap="round" />
      </g>
      <g id="snag">
        <path d="M0 0 V-14 M0 -9 l-5 -5 M0 -11 l4 -6 M0 -6 l5 -3" stroke="#1A1513" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
      <g id="shrub">
        <ellipse cx="2" cy="1" rx="7" ry="2.4" fill="#000" opacity="0.2" />
        <ellipse cx="0" cy="-3" rx="6" ry="4.4" fill={P.shrubD} />
        <ellipse cx="-1.6" cy="-4.6" rx="4" ry="3" fill={P.shrub} />
      </g>
    </defs>
  );
}

/** The San Gabriel Mountains behind the town, fading into haze. */
function Ridges({ P, id }: { P: GroundPalette; id: string }) {
  return (
    <g aria-hidden="true">
      <defs>
        {P.mtn.map((c, i) => (
          <linearGradient key={i} id={`${id}${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={c} stopOpacity={0.6 + i * 0.18} />
            <stop offset="0.55" stopColor={c} stopOpacity={0.35 + i * 0.12} />
            <stop offset="1" stopColor={c} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {RIDGES.map((d, i) => <path key={i} d={d} fill={`url(#${id}${i})`} />)}
    </g>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const StaticGround = memo(function StaticGround({ P, pack, lite, from, epoch }: { P: GroundPalette; pack: Pack; lite: boolean; rotation: number; assets: number; from: Pack | null; epoch: number }) {
  // the look the map just left (dusk -> night when the fire starts) dissolves over the new one,
  // each layer in its own place: the old sky over the new sky, the old ground plate over the new plate
  const fromUrl = from ? groundUrl(from, lite, viewRotation()) : '';
  return (
    <>
      <Ridges P={P} id="mtn" />
      {from && <g key={`m${epoch}`} className="pack-out"><Ridges P={PALETTES[from]} id="mtnFrom" /></g>}
      <polygon points={pointsAttr([project(0, 0), project(MAP_W, 0), project(MAP_W, MAP_H), project(0, MAP_H)].map(([x, y]) => [x + (x > 720 ? 10 : -8), y + 42] as [number, number]))} fill="#000" opacity={lite ? 0.22 : 0.35} filter={lite ? undefined : 'url(#blur20)'} />
      {/* the board itself (terrain, roads, sidewalks, park, lots, soil edge) is one Blender render;
          the flat polygon underneath only shows while the image loads */}
      <polygon points={pointsAttr([project(0, 0), project(MAP_W, 0), project(MAP_W, MAP_H), project(0, MAP_H)])} fill={P.ground} />
      {ready(groundUrl(pack, lite, viewRotation())) && <image href={groundUrl(pack, lite, viewRotation())} x={GROUND_PLATE.x} y={GROUND_PLATE.y} width={GROUND_PLATE.w} height={GROUND_PLATE.h} preserveAspectRatio="none" />}
      {from && ready(fromUrl) && <image key={`g${epoch}`} className="pack-out" href={fromUrl} x={GROUND_PLATE.x} y={GROUND_PLATE.y} width={GROUND_PLATE.w} height={GROUND_PLATE.h} preserveAspectRatio="none" />}
      <g transform={groundMatrix()}>
        <g style={{ opacity: P.lampOp, transition: 'opacity 2s ease' }}>
          {LAMPS.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="34" fill="url(#lamp)" />)}
        </g>
      </g>
    </>
  );
});

/** The render for this view; until a turned render has loaded, the original one stands in. */
function pickSprite(kind: Building['kind'], variant: string): string {
  const r = viewRotation();
  const url = spriteUrl(kind, variant, r);
  return !r || ready(url) ? url : spriteUrl(kind, variant, 0);
}

/** Screen-space wind for smoke: on-screen direction (ux, uy) and strength (1 = 40 mph). */
interface Wind { ux: number; uy: number; s: number }
const f1 = (n: number) => n.toFixed(1);
/** A smoke path that rises `h` and is bent `reach` downwind, the way a column leans in a steady wind. */
function windPath(w: Wind, h: number, reach: number): string {
  const r = reach * w.s;
  return `M0 0 C ${f1(w.ux * r * 0.06)} ${f1(-h * 0.45)} ${f1(w.ux * r * 0.45)} ${f1(-h * 0.85 + w.uy * r * 0.2)} ${f1(w.ux * r)} ${f1(-h + w.uy * r * 0.45)}`;
}

function BuildingSprite({ b, pack, selected, onSelect, lite, ghost, wind }: { b: Building; pack: Pack; selected: boolean; onSelect: (id: number) => void; lite: boolean; ghost: { variant: string; epoch: number } | null; wind: Wind }) {
  const s = spriteScale(b);
  // geometry in the turned view: the visible faces are always the view's front (+y) and side (+x)
  const r = rotRect(b);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const [sx, sy] = projectRaw(cx, cy);
  const roof = SPRITE[b.kind].roof * s;
  const damage = b.damage ?? 0;
  const variant = spriteVariant(pack, b.status, damage);
  const prev = previousVariant(pack, variant);
  const hull: [number, number][] = [
    projectRaw(r.x, r.y, roof), projectRaw(r.x + r.w, r.y, roof), projectRaw(r.x + r.w, r.y, 0),
    projectRaw(r.x + r.w, r.y + r.h, 0), projectRaw(r.x, r.y + r.h, 0), projectRaw(r.x, r.y + r.h, roof),
  ];
  const roofPts = [[0.2, 0.3], [0.45, 0.62], [0.72, 0.35], [0.86, 0.72], [0.3, 0.82], [0.6, 0.14], [0.52, 0.45], [0.12, 0.62]]
    .map(([fx, fy]) => projectRaw(r.x + fx * r.w, r.y + fy * r.h, roof));
  // fire breaking out of the windows on the two visible faces once the building is gutted
  const facePts = [[0.18, 0.62], [0.42, 0.42], [0.7, 0.7], [0.88, 0.5]].map(([fx, fz]) => projectRaw(r.x + fx * r.w, r.y + r.h, roof * fz))
    .concat([[0.3, 0.55], [0.75, 0.75]].map(([fy, fz]) => projectRaw(r.x + r.w, r.y + fy * r.h, roof * fz)));
  const [rx, ry] = projectRaw(cx, cy, roof);
  const label = `${b.name}, ${b.kind}, ${b.status}`;
  const box = { x: sx - SPRITE_BOX.ax * s, y: sy - SPRITE_BOX.ay * s, width: SPRITE_BOX.w * s, height: SPRITE_BOX.h * s };
  const heavy = b.status === 'burning' && damage >= 2;

  return (
    <g>
      {/* the previous damage stage fades out underneath while the new one fades in */}
      {prev && <image key={`prev-${prev}`} className={variant === 'lost' ? 'sprite-collapse' : 'sprite-out'} href={pickSprite(b.kind, prev)} {...box} preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />}
      <image key={`cur-${variant}`} className={prev ? (variant === 'lost' ? 'sprite-in-late' : 'sprite-in') : undefined} href={pickSprite(b.kind, variant)} {...box} preserveAspectRatio="none"
        filter={b.status === 'burning' && !lite ? 'url(#heatHaze)' : undefined} style={{ pointerEvents: 'none' }} />
      {/* the look the map just left (dusk, or the ruins before a reset) dissolves over the new sprite */}
      {ghost && ghost.variant !== variant && (
        <image key={`ghost-${ghost.epoch}`} className="pack-out" href={pickSprite(b.kind, ghost.variant)} {...box} preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />
      )}
      {/* rooms: power failing, then fire moving through them */}
      <WindowLayer b={b} ox={box.x} oy={box.y} s={s} lite={lite} />
      {b.status === 'burning' && (() => {
        // fire builds over time: first smoke from the windows, then flames that spread across the roof
        const p = Math.min(1, b.burnProgress ?? 0);
        const grow = Math.min(1, p / 0.55);
        const nRoof = Math.max(1, Math.round(1 + grow * 7));
        const flameScale = (0.45 + grow * 0.9) * (heavy ? 1.5 : 1);
        // the smoke column thickens as the fire takes hold and leans downwind
        const column = (0.55 + grow * 0.45) * (heavy ? 1.35 : 1);
        const rise = windPath(wind, 120, 170);
        const leak = windPath(wind, 60, 85);
        return (
          <g style={{ pointerEvents: 'none' }}>
            {/* fire light on the roof, breathing (kept out of the warp filter: it does not need it, and it is big) */}
            <g className="glow-flicker">
              <ellipse cx={rx} cy={ry} rx={(0.433 * (b.w + b.h) + 24) * (heavy ? 1.35 : 1)} ry={(0.25 * (b.w + b.h) + 30) * (heavy ? 1.35 : 1)} fill="url(#roofGlow)"
                style={{ opacity: 0.25 + grow * 0.75, transition: 'opacity 1.5s ease', ...(lite ? {} : { mixBlendMode: 'screen' as const }) }} />
            </g>
            {/* early smoke leaking from the facade, thinning as the flames take over */}
            <g style={{ opacity: Math.max(0.15, 1 - grow * 0.6), transition: 'opacity 2s ease' }}>
              {facePts.slice(0, 4).map(([px, py], i) => (
                <circle key={`ws${i}`} cx={px} cy={py} r="6" fill="url(#smokeDark)">
                  <animate attributeName="r" values="4;22" dur="3.4s" begin={`${-i * 0.8}s`} repeatCount="indefinite" />
                  <animateMotion path={leak} dur="3.4s" begin={`${-i * 0.8}s`} repeatCount="indefinite" />
                </circle>
              ))}
            </g>
            <g filter={lite ? undefined : 'url(#flameWarp)'} style={lite ? undefined : { mixBlendMode: 'screen' }}>
            {roofPts.slice(0, nRoof).map(([px, py], i) => (
              <g key={i} transform={`translate(${px} ${py})`}>
                <g className="flame-grow" style={{ animationDelay: `${i * 140}ms` }}>
                  <g style={{ transform: `scale(${flameScale * (i % 4 === 0 ? 1.35 : 1)})`, transition: 'transform 1.6s ease' }}>
                    <use href={`#${FLAMES[i % 3]}`} />
                  </g>
                </g>
              </g>
            ))}
            {heavy && facePts.map(([px, py], i) => (
              <g key={`w${i}`} transform={`translate(${px} ${py})`}>
                <g className="flame-grow" style={{ animationDelay: `${i * 220}ms` }}><use href={`#${FLAMES[(i + 1) % 3]}`} transform={`scale(${0.8 + (i % 3) * 0.2})`} /></g>
              </g>
            ))}
            </g>
            {/* the smoke column: always five puffs on one clock, scaled up as the fire grows (no puffs popping in) */}
            <g transform={`translate(${f1(rx)} ${f1(ry - 12)})`}>
              <g style={{ transform: `scale(${column.toFixed(2)})`, transition: 'transform 2.5s ease' }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <circle key={i} cx={f1((roofPts[(i * 2) % 8][0] - rx) * 0.6)} cy="0" r="10" fill="url(#smokeDark)">
                    <animate attributeName="r" values="9;46" dur="5s" begin={`${-i}s`} repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0;0.85;0" dur="5s" begin={`${-i}s`} repeatCount="indefinite" />
                    <animateMotion path={rise} dur="5s" begin={`${-i}s`} repeatCount="indefinite" />
                  </circle>
                ))}
              </g>
            </g>
          </g>
        );
      })()}
      {b.status === 'lost' && (
        <g style={{ pointerEvents: 'none' }}>
          {/* the collapse itself: a dust cloud rolls out and sparks jump, once */}
          <circle className="dust-burst" cx={sx} cy={sy - roof * 0.25} r={0.3 * (b.w + b.h)} fill="url(#smokeGray)" />
          {[[-60, -70], [40, -90], [-20, -110], [70, -60], [-80, -40], [10, -80], [55, -100], [-45, -95]].map(([dx, dy], i) => (
            <circle key={`sp${i}`} className="spark" cx={sx + (i - 4) * 6} cy={sy - roof * 0.3} r="1.6" fill="#FFC46B" style={{ '--dx': `${dx}px`, '--dy': `${dy}px`, animationDelay: `${i * 0.05}s` } as CSSProperties} />
          ))}
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={roofPts[i * 3][0]} cy={sy - roof * 0.3} r="8" fill="url(#smokeGray)">
              <animate attributeName="r" values="6;30" dur="8s" begin={`${-i * 2.6}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0;0.5;0" dur="8s" begin={`${-i * 2.6}s`} repeatCount="indefinite" />
              <animateMotion path="M0 0 C -20 -40 -50 -70 -100 -100" dur="8s" begin={`${-i * 2.6}s`} repeatCount="indefinite" />
            </circle>
          ))}
        </g>
      )}
      <polygon
        points={pointsAttr(hull)}
        fill="transparent"
        stroke={selected ? STATUS_COLORS.amber : 'none'}
        strokeWidth={selected ? 1.5 : 0}
        strokeDasharray="5 4"
        style={{ cursor: 'pointer', pointerEvents: 'all' }}
        onClick={(e) => { e.stopPropagation(); onSelect(b.id); }}
        role="button"
        aria-label={label}
      />
    </g>
  );
}

const BURN_TICKS = 3;
const COOL_TICKS = 7;
/** Stable 0..1 jitter per cell so neighbours ignite a few hundred ms apart instead of in lockstep. */
const jitter = (id: number) => ((id * 2654435761) % 1000) / 1000;

export const Town = memo(function Town({ sim, buildings, fireCells, pack, selectedId, onSelect, svgRef, tagScale = 1, lite = false, units = [], rotation = 0, assets = 0, ghost = null, tickSeconds = TICK_SECONDS, plantSeed = 7, ignition = null, onPick }: TownProps) {
  const P = PALETTES[pack];
  // what the map looked like a moment ago, while it dissolves (look change, fire start, reset)
  const ghostPack = ghost && ghost.pack !== pack ? ghost.pack : null;
  const ghostCells = useMemo(() => (ghost ? stateMap(ghost.cells) : null), [ghost]);
  const ghostVariant = (b: Building) => {
    const o = ghost?.buildings.find((x) => x.id === b.id);
    return ghost && o ? { variant: spriteVariant(ghost.pack, o.status, o.damage ?? 0), epoch: ghost.epoch } : null;
  };
  const leftFire = ghost !== null && ghost.phase !== 'prep' && sim.phase === 'prep';
  // plants only depend on building footprints, which never change during a run, and the scenario's seed
  const footprintKey = buildings.map((b) => `${b.x},${b.y},${b.w},${b.h}`).join('|');
  const plants = useMemo(
    () => generatePlants(footprintKey.split('|').map((s) => { const [x, y, w, h] = s.split(',').map(Number); return { x, y, w, h }; }), plantSeed),
    [footprintKey, plantSeed],
  );
  // a new scenario re-scatters the trees and brush: the ones that moved dissolve while the new ones grow in
  const oldPlants = useOutgoing(plants, 2100);
  const oldKeys = useMemo(() => (oldPlants ? new Set(oldPlants.map(plantKey)) : null), [oldPlants]);
  // the fire-start marker shows before the fire and fades out once it starts (the scenario row stays)
  const igOn = sim.phase === 'prep' && !!ignition;
  const igShown = useLinger(igOn, 1400);
  const shelter = buildings.find((b) => b.kind === 'shelter');

  const cellState = useMemo(() => stateMap(fireCells), [fireCells]);
  const burning = fireCells.filter((c) => c.state === 1);
  const burnedAll = fireCells.filter((c) => c.state === 2);
  // burnTicks keeps counting after a cell goes out, so it cools from embers to ash over a few ticks
  const cooling = burnedAll.filter((c) => c.burnTicks < BURN_TICKS + COOL_TICKS);
  const burned = burnedAll.filter((c) => c.burnTicks >= BURN_TICKS + COOL_TICKS);
  const dying = burnedAll.filter((c) => c.burnTicks < BURN_TICKS + 2);
  const fireOn = burning.length > 0;
  const cellPath = (cells: FireCell[]) => cells.map((c) => `M${c.x * CELL} ${c.y * CELL}h${CELL}v${CELL}h${-CELL}z`).join('');

  const inBuilding = (mx: number, my: number) => buildings.some((b) => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);

  // fire centroid for smoke + glow
  let fcx = 0, fcy = 0;
  for (const c of burning) { fcx += c.x * CELL + CELL / 2; fcy += c.y * CELL + CELL / 2; }
  if (burning.length) { fcx /= burning.length; fcy /= burning.length; }
  // the fire's light and smoke glide after the front between ticks, and linger to fade out when it dies
  const lastFire = useRef<[number, number]>([MAP_W * 0.8, MAP_H * 0.2]);
  useLayoutEffect(() => { if (fireOn) lastFire.current = [fcx, fcy]; });
  const [ffx, ffy] = fireOn ? [fcx, fcy] : lastFire.current;
  const fxOn = useLinger(fireOn, 2600);
  const [gsx, gsy] = project(ffx, ffy);
  const [wx, wy] = windVector(sim.windDirDeg);
  const [wsx, wsy] = projectVec(wx, wy);
  const smokePath = `M0 0 C ${wsx * 140} ${wsy * 140 - 70} ${wsx * 340} ${wsy * 340 - 140} ${wsx * 580} ${wsy * 580 - 200}`;
  const ws = windScreen(sim.windDirDeg);
  const wind = useMemo(() => ({ ux: ws.ux, uy: ws.uy, s: Math.min(1.4, Math.max(0.4, sim.windMph / 40)) }), [ws.ux, ws.uy, sim.windMph]);

  // ---------------- billboards sorted back-to-front by map depth (x + y)
  const items: { depth: number; key: string; node: ReactNode }[] = [];
  const propSize = (type: string, i: number) => (type === 'shrub' ? 0.8 : type === 'palm' ? 1.12 : 0.92) + ((i * 37) % 10) / 40;
  const plantKeys = new Set<string>();
  for (const [i, p] of plants.entries()) {
    // keyed by place: a tree that stays put across scenarios keeps its element (no flicker)
    let pk = plantKey(p);
    if (plantKeys.has(pk)) pk += `_${i}`;
    plantKeys.add(pk);
    const grows = oldKeys !== null && !oldKeys.has(pk);
    const k = cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
    const st = cellState.get(k) ?? 0;
    const gst = ghostCells ? (ghostCells.get(k) ?? 0) : st;
    const gone = p.type === 'shrub' && st === 2;
    const wasGone = p.type === 'shrub' && gst === 2;
    if (gone && (!ghost || wasGone)) continue;
    const [px, py] = project(p.x, p.y);
    const type = st === 2 ? 'snag' : p.type;
    const gType = gst === 2 ? 'snag' : p.type;
    // deterministic size jitter so the rows of trees do not look stamped
    const img = (t: typeof type, pk: Pack, cls?: string, key?: string) => {
      const sc = propSize(t, i);
      return (
        <image key={key} className={cls} href={propUrl(t, pk)} x={px - PROP_BOX.ax * sc} y={py - PROP_BOX.ay * sc} width={PROP_BOX.w * sc} height={PROP_BOX.h * sc}
          preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />
      );
    };
    const fromChanged = ghost && !wasGone && (gType !== type || gone || ghost.pack !== pack);
    items.push({
      depth: depthOf(p.x, p.y),
      key: `p${pk}`,
      node: (
        <>
          {!gone && img(type, pack, (ghost && wasGone) || grows ? 'fx-in' : undefined, 'cur')}
          {fromChanged && img(gType, ghost.pack, 'pack-out', `from${ghost.epoch}`)}
        </>
      ),
    });
  }
  if (oldPlants) {
    for (const [i, p] of oldPlants.entries()) {
      if (plantKeys.has(plantKey(p))) continue;
      const [px, py] = project(p.x, p.y);
      const sc = propSize(p.type, i);
      items.push({
        depth: depthOf(p.x, p.y),
        key: `o${plantKey(p)}_${i}`,
        node: <image className="pack-out" href={propUrl(p.type, pack)} x={px - PROP_BOX.ax * sc} y={py - PROP_BOX.ay * sc} width={PROP_BOX.w * sc} height={PROP_BOX.h * sc} preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />,
      });
    }
  }
  for (const b of buildings) {
    items.push({
      depth: depthOf(b.x + b.w / 2, b.y + b.h / 2),
      key: `b${b.id}`,
      node: <BuildingSprite b={b} pack={pack} selected={selectedId === b.id} onSelect={onSelect} lite={lite} ghost={ghostVariant(b)} wind={wind} />,
    });
  }
  let flameCount = 0;
  for (const c of burning) {
    if (flameCount > (lite ? 90 : 260) || c.fuel < 0.3) continue;
    const mx = c.x * CELL + CELL / 2;
    const my = c.y * CELL + CELL / 2;
    if (inBuilding(mx, my)) continue;
    const [fx, fy] = project(mx, my);
    const h = (c.x * 7 + c.y * 13) % 3;
    const delay = `${Math.round(jitter(c.id) * 650)}ms`;
    items.push({
      depth: depthOf(mx, my),
      key: `f${c.id}`,
      node: (
        <g transform={`translate(${fx} ${fy})`}>
          <g className="flame-grow" style={{ animationDelay: delay }}><use href={`#${FLAMES[h]}`} /></g>
        </g>
      ),
    });
    flameCount++;
  }
  for (const c of dying) {
    if (c.fuel < 0.3 || lite) continue;
    const mx = c.x * CELL + CELL / 2;
    const my = c.y * CELL + CELL / 2;
    if (inBuilding(mx, my)) continue;
    const [fx, fy] = project(mx, my);
    items.push({
      depth: depthOf(mx, my),
      key: `d${c.id}`,
      node: (
        <g transform={`translate(${fx} ${fy})`}>
          <g className="flame-die"><use href={`#${FLAMES[(c.x + c.y) % 3]}`} /></g>
        </g>
      ),
    });
  }
  items.sort((a, b) => a.depth - b.depth);

  const evacuating = buildings.filter((b) => b.status === 'evacuating');

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="town-svg"
      role="img"
      aria-label="Simulated neighborhood map"
      onClick={() => onSelect(null)}
    >
      <Defs P={P} />
      <StaticGround P={P} pack={pack} lite={lite} rotation={rotation} assets={assets} from={ghostPack} epoch={ghost?.epoch ?? 0} />

      {/* ground-level dynamic layer: fire cells, rings, routes */}
      <g transform={groundMatrix()}>
        {fxOn && (
          <circle className="fx-in" r="300" fill="url(#groundGlow)"
            style={{ transform: `translate(${f1(ffx)}px, ${f1(ffy)}px)`, opacity: fireOn ? P.glowOp : 0, transition: 'transform 1.1s linear, opacity 2.4s ease' }} />
        )}
        {/* settled ash */}
        <path d={cellPath(burned)} fill="url(#ash)" filter={lite ? undefined : 'url(#blur2)'} opacity="0.92" />
        {/* after a reset the burn scar fades away instead of vanishing */}
        {leftFire && ghost && (
          <path key={`ash${ghost.epoch}`} className="pack-out" d={cellPath(ghost.cells.filter((c) => c.state === 2))} fill="url(#ash)" filter={lite ? undefined : 'url(#blur2)'} />
        )}
        {/* recently burnt: ash fades in under embers that dim and go out */}
        <g filter={lite ? undefined : 'url(#blur2)'}>
          {cooling.map((c) => (
            <g key={`k${c.id}`}>
              <rect className="cell-ash" x={c.x * CELL} y={c.y * CELL} width={CELL} height={CELL} fill="url(#ash)" />
              <rect className="cell-cool" x={c.x * CELL} y={c.y * CELL} width={CELL} height={CELL} fill="#B8320E" />
            </g>
          ))}
        </g>
        {/* burning front: each cell catches a moment apart, flares, then the whole front flickers together
            (one animation on the layer instead of one per cell) */}
        <g className="front-flicker" filter={lite ? undefined : 'url(#blur2)'}>
          {burning.map((c) => (
            <rect key={`b${c.id}`} className="cell-ignite" x={c.x * CELL - 2} y={c.y * CELL - 2} width={CELL + 4} height={CELL + 4} rx="6"
              fill={c.burnTicks >= 2 ? '#E2470F' : '#FF6A1F'} style={{ animationDelay: `${Math.round(jitter(c.id) * 650)}ms` }} />
          ))}
        </g>
        {buildings.map((b) => {
          const ring = { x: b.x - 16, y: b.y - 16, w: b.w + 32, h: b.h + 32 };
          if (b.status === 'behind') {
            return (
              <rect key={`r${b.id}`} x={ring.x} y={ring.y} width={ring.w} height={ring.h} rx="18" fill={STATUS_COLORS.red} fillOpacity="0.12" stroke={STATUS_COLORS.red} strokeWidth="2.6">
                <animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite" />
              </rect>
            );
          }
          if (b.prepared && sim.phase === 'prep') {
            return <rect key={`r${b.id}`} x={ring.x - 6} y={ring.y - 6} width={ring.w + 12} height={ring.h + 12} rx="20" fill="#D9D2C2" fillOpacity="0.18" stroke={STATUS_COLORS.green} strokeWidth="2.4" strokeDasharray="7 5" />;
          }
          return null;
        })}
        {evacuating.map((b) => (
          <path key={`e${b.id}`} d={'M' + evacRoute(b, shelter).map(([x, y]) => `${x} ${y}`).join(' L')} stroke={STATUS_COLORS.green} strokeWidth="2.2" opacity="0.6" fill="none" strokeDasharray="3 9" strokeLinecap="round" strokeLinejoin="round">
            <animate attributeName="stroke-dashoffset" from="24" to="0" dur="1.4s" repeatCount="indefinite" />
          </path>
        ))}
        {/* picking the fire start: the whole board takes the click, read back in map units through this layer's transform */}
        {onPick && (
          <rect className="pick-ground" x="0" y="0" width={MAP_W} height={MAP_H} fill="transparent"
            onClick={(e) => {
              e.stopPropagation();
              const m = e.currentTarget.getScreenCTM();
              if (!m) return;
              const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
              onPick(p.x, p.y);
            }} />
        )}
      </g>

      {/* cars, strolling residents, evacuation columns and vans; engines on the road */}
      <StreetLife buildings={buildings} phase={sim.phase} pack={pack} fadeFrom={ghost} />
      {/* engines: one persistent sprite per unit, driven frame by frame along its route */}
      <FireUnits units={units} buildings={buildings} tickSeconds={tickSeconds} pack={pack} layer="under" rotation={rotation} />

      {/* depth-sorted world */}
      {items.map((it) => <g key={it.key}>{it.node}</g>)}

      {/* hoses and mist stay visible above the buildings */}
      <FireUnits units={units} buildings={buildings} tickSeconds={tickSeconds} pack={pack} layer="over" lite={lite} />

      {/* wind: gust lines drifting across the town, the way the smoke leans */}
      <WindStreaks dirDeg={sim.windDirDeg} mph={sim.windMph} pack={pack} phase={sim.phase} lite={lite} rotation={rotation} />

      {/* smoke, embers, fire light: glide after the fire front between ticks, fade in and out with it */}
      {fxOn && (
        <g className="fx-in" style={{ pointerEvents: 'none', opacity: fireOn ? 1 : 0, transition: 'opacity 2.4s ease' }}>
          <g style={{ transform: `translate(${f1(gsx)}px, ${f1(gsy)}px)`, transition: 'transform 1.1s linear' }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <circle key={i} r="30" fill="url(#smokePlume)">
                <animate attributeName="r" values="26;120" dur="11s" begin={`${-i * 1.8}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values={`0;${P.smokeOp};0`} dur="11s" begin={`${-i * 1.8}s`} repeatCount="indefinite" />
                <animateMotion path={smokePath} dur="11s" begin={`${-i * 1.8}s`} repeatCount="indefinite" />
              </circle>
            ))}
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <circle key={`e${i}`} cx={(i - 3) * 14} cy={(i % 3) * 10} r={1.3 + (i % 3) * 0.3} fill="#FFC46B">
                <animateMotion path={`M0 0 C ${wsx * 60} ${-50 - i * 6} ${wsx * 160} ${-70} ${wsx * (220 + i * 30)} -30`} dur={`${3 + (i % 3)}s`} begin={`${-i * 0.6}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;1;0" dur={`${3 + (i % 3)}s`} begin={`${-i * 0.6}s`} repeatCount="indefinite" />
              </circle>
            ))}
            <ellipse rx="460" ry="300" fill="url(#fireGlow)" opacity={P.glowOp * (lite ? 0.7 : 1)} style={lite ? undefined : { mixBlendMode: 'screen' }}>
              <animate attributeName="rx" values="440;470;450;440" dur="2.6s" repeatCount="indefinite" />
            </ellipse>
          </g>
        </g>
      )}

      {/* where the fire will start: glides when the start moves, fades out as the fire takes over */}
      {igShown && ignition && <IgnitionMarker key={`ig${rotation}`} x={ignition.x} y={ignition.y} picked={ignition.picked} scale={tagScale} visible={igOn} />}

      {/* waypoint markers: stem + numbered diamond + halo lettering (no pills) */}
      <Markers buildings={buildings} phase={sim.phase} scale={tagScale} selectedId={selectedId} />
    </svg>
  );
});
