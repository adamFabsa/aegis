import { memo, useMemo, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { Building, FireCell, Pack, Sim } from './types';
import { CELL, GROUND_MATRIX, MAP_H, MAP_W, OX, OY, VIEW_H, VIEW_W, pointsAttr, project, projectVec, windVector } from './iso';
import {
  HILLS_EDGE, HILLS_PATH, LAMPS, LOTS, PARK, PROP_BOX, ROAD_LINES, ROADS, SIDEWALKS, SPRITE, SPRITE_BOX, propUrl,
  evacRoute, generatePlants, previousVariant, ridgePaths, spriteScale, spriteUrl, spriteVariant,
} from './scene';
import { PALETTES, STATUS_COLORS, type GroundPalette } from './palettes';
import { FireUnits, Markers, StreetLife } from './markers';
import { WindowLayer } from './WindowLayer';
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
}

const LOT_STRIPES =
  'M614 490 V514 M628 490 V514 M642 490 V514 M656 490 V514 M670 490 V514 M684 490 V514 M698 490 V514 M712 490 V514 M726 490 V514 ' +
  'M614 558 V582 M628 558 V582 M642 558 V582 M656 558 V582 M670 558 V582 M684 558 V582 M698 558 V582 M712 558 V582 M726 558 V582 ' +
  'M20 496 H46 M20 510 H46 M20 524 H46 M20 538 H46 M20 552 H46 M20 566 H46 M20 580 H46 ' +
  'M98 496 H124 M98 510 H124 M98 524 H124 M98 538 H124 M98 552 H124 M98 566 H124 M98 580 H124';
const CROSSWALKS =
  'M363 421 v7 M369 421 v7 M375 421 v7 M381 421 v7 M387 421 v7 M363 468 v7 M369 468 v7 M375 468 v7 M381 468 v7 M387 468 v7 ' +
  'M351 433 h7 M351 439 h7 M351 445 h7 M351 451 h7 M351 457 h7 M394 433 h7 M394 439 h7 M394 445 h7 M394 451 h7 M394 457 h7';

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
      <filter id="asphalt" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves={1} seed={3} result="n" />
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 2.2 -1.15" result="a" />
        <feComposite in="a" in2="SourceGraphic" operator="in" />
      </filter>
      <pattern id="mow" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
        <rect width="20" height="40" fill="#fff" opacity="0.06" />
      </pattern>
      <clipPath id="hillsClip"><path d={HILLS_PATH} /></clipPath>
      <pattern id="brush" width="16" height="14" patternUnits="userSpaceOnUse">
        <rect width="16" height="14" fill={P.brush} />
        <circle cx="3" cy="4" r="2.4" fill={P.brushD} />
        <circle cx="11" cy="9" r="2.8" fill={P.brushD} />
        <circle cx="7" cy="12" r="1.4" fill={P.brushHi} />
        <circle cx="13.5" cy="2.5" r="1.3" fill={P.brushHi} />
        <path d="M1 10 l2 -3 M9 4 l1.5 -3 M14 13 l1 -2.5" stroke={P.brushHi} strokeWidth="0.7" fill="none" />
      </pattern>
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

const StaticGround = memo(function StaticGround({ P, lite }: { P: GroundPalette; lite: boolean }) {
  return (
    <>
      {/* the San Gabriel Mountains behind the town, fading into haze */}
      <g aria-hidden="true">
        <defs>
          {P.mtn.map((c, i) => (
            <linearGradient key={i} id={`mtn${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={c} stopOpacity={0.6 + i * 0.18} />
              <stop offset="0.55" stopColor={c} stopOpacity={0.35 + i * 0.12} />
              <stop offset="1" stopColor={c} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {RIDGES.map((d, i) => <path key={i} d={d} fill={`url(#mtn${i})`} />)}
      </g>
      <polygon points="575,160 1430,660 884,975 10,470" fill="#000" opacity={lite ? 0.22 : 0.35} filter={lite ? undefined : 'url(#blur20)'} />
      <g transform={`translate(${OX} ${OY})`}>
        <g transform={`matrix(0.866 0.5 0 1 ${-0.866 * MAP_H} ${0.5 * MAP_H})`}>
          <rect width={MAP_W} height="22" fill={P.slabFront} />
          <rect y="7" width={MAP_W} height="1.2" fill="#000" opacity="0.18" />
          <rect y="14" width={MAP_W} height="1.2" fill="#000" opacity="0.14" />
          <rect width={MAP_W} height="22" fill="url(#slabShade)" />
        </g>
        <g transform={`matrix(0.866 -0.5 0 1 ${0.866 * (MAP_W - MAP_H)} ${0.5 * (MAP_W + MAP_H)})`}>
          <rect width={MAP_H} height="22" fill={P.slabSide} />
          <rect y="7" width={MAP_H} height="1.2" fill="#000" opacity="0.18" />
          <rect y="14" width={MAP_H} height="1.2" fill="#000" opacity="0.14" />
          <rect width={MAP_H} height="22" fill="url(#slabShade)" />
        </g>
      </g>
      <g transform={GROUND_MATRIX}>
        <rect width={MAP_W} height={MAP_H} fill={P.ground} />
        {!lite && (
          <>
            <rect width={MAP_W} height={MAP_H} fill="#000" filter="url(#patches)" opacity={P.patchOp} />
            <rect width={MAP_W} height={MAP_H} fill="#fff" filter="url(#patchesHi)" opacity={P.patchOp * 0.6} />
            <rect width={MAP_W} height={MAP_H} fill="#000" filter="url(#grain)" opacity={P.grainOp} />
          </>
        )}
        <rect x={PARK.x} y={PARK.y} width={PARK.w} height={PARK.h} rx="14" fill={P.lawn} />
        <rect x={PARK.x} y={PARK.y} width={PARK.w} height={PARK.h} rx="14" fill="url(#mow)" opacity={P.patchOp > 0.3 ? 0.45 : 1} />
        <rect x={PARK.x} y={PARK.y} width={PARK.w} height={PARK.h} rx="14" fill="none" stroke={P.curb} strokeWidth="2" opacity="0.6" />
        <ellipse cx="128" cy="86" rx="44" ry="26" fill={P.water} />
        <ellipse cx="128" cy="86" rx="44" ry="26" fill="none" stroke={P.sidewalk} strokeWidth="3" />
        <path d="M24 150 C 110 120 220 190 334 136" stroke={P.sidewalk} strokeWidth="5" fill="none" />
        <path d={HILLS_PATH} fill="url(#brush)" />
        <path d="M600 22 C 700 60 820 66 1000 40 M640 92 C 740 122 860 150 1000 140 M720 162 C 800 178 900 204 1000 232" stroke={P.brushHi} strokeWidth="5" fill="none" opacity="0.35" filter={lite ? undefined : 'url(#blur4)'} />
        {/* elevation lip: a shaded band just inside the hills edge and a soft cast shadow onto the town side */}
        <g clipPath="url(#hillsClip)">
          <path d={HILLS_EDGE} stroke="#000" strokeWidth="26" fill="none" opacity={P.lipOp * (lite ? 0.6 : 1)} filter={lite ? undefined : 'url(#blur4)'} />
          <path d={HILLS_EDGE} stroke={P.brushHi} strokeWidth="6" fill="none" opacity="0.35" transform="translate(-6 -6)" filter={lite ? undefined : 'url(#blur2)'} />
        </g>
        <path d={HILLS_EDGE} stroke={P.brushD} strokeWidth="4" fill="none" opacity="0.7" filter={lite ? undefined : 'url(#blur2)'} />
        {LOTS.map((l, i) => <rect key={i} x={l.x} y={l.y} width={l.w} height={l.h} rx="4" fill={P.lot} />)}
        <path d={LOT_STRIPES} stroke={P.roadLine} strokeWidth="1.4" />
        {SIDEWALKS.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={P.sidewalk} />)}
        {SIDEWALKS.map((r, i) => <rect key={`c${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={P.curb} strokeWidth="1.5" opacity="0.7" />)}
        {ROADS.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={P.road} />)}
        {!lite && ROADS.map((r, i) => <rect key={`a${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="#fff" filter="url(#asphalt)" opacity={P.asphaltOp} />)}
        {ROADS.map((r, i) => <rect key={`e${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#000" strokeWidth="2" opacity="0.25" />)}
        <path d={ROAD_LINES} stroke={P.roadLine} strokeWidth="1.6" strokeDasharray="12 10" fill="none" />
        <path d={CROSSWALKS} stroke={P.roadLine} strokeWidth="3" opacity="0.8" />
        <g opacity={P.lampOp}>
          {LAMPS.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="34" fill="url(#lamp)" />)}
        </g>
      </g>
    </>
  );
});

function BuildingSprite({ b, pack, selected, onSelect, lite }: { b: Building; pack: Pack; selected: boolean; onSelect: (id: number) => void; lite: boolean }) {
  const s = spriteScale(b);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const [sx, sy] = project(cx, cy);
  const roof = SPRITE[b.kind].roof * s;
  const damage = b.damage ?? 0;
  const variant = spriteVariant(pack, b.status, damage);
  const prev = previousVariant(pack, variant);
  const hull: [number, number][] = [
    project(b.x, b.y, roof), project(b.x + b.w, b.y, roof), project(b.x + b.w, b.y, 0),
    project(b.x + b.w, b.y + b.h, 0), project(b.x, b.y + b.h, 0), project(b.x, b.y + b.h, roof),
  ];
  const roofPts = [[0.2, 0.3], [0.45, 0.62], [0.72, 0.35], [0.86, 0.72], [0.3, 0.82], [0.6, 0.14], [0.52, 0.45], [0.12, 0.62]]
    .map(([fx, fy]) => project(b.x + fx * b.w, b.y + fy * b.h, roof));
  // fire breaking out of the windows on the two visible faces once the building is gutted
  const facePts = [[0.18, 0.62], [0.42, 0.42], [0.7, 0.7], [0.88, 0.5]].map(([fx, fz]) => project(b.x + fx * b.w, b.y + b.h, roof * fz))
    .concat([[0.3, 0.55], [0.75, 0.75]].map(([fy, fz]) => project(b.x + b.w, b.y + fy * b.h, roof * fz)));
  const [rx, ry] = project(cx, cy, roof);
  const label = `${b.name}, ${b.kind}, ${b.status}`;
  const box = { x: sx - SPRITE_BOX.ax * s, y: sy - SPRITE_BOX.ay * s, width: SPRITE_BOX.w * s, height: SPRITE_BOX.h * s };
  const heavy = b.status === 'burning' && damage >= 2;

  return (
    <g>
      {/* the previous damage stage fades out underneath while the new one fades in */}
      {prev && <image key={`prev-${prev}`} className={variant === 'lost' ? 'sprite-collapse' : 'sprite-out'} href={spriteUrl(b.kind, prev)} {...box} preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />}
      <image key={`cur-${variant}`} className={prev ? (variant === 'lost' ? 'sprite-in-late' : 'sprite-in') : undefined} href={spriteUrl(b.kind, variant)} {...box} preserveAspectRatio="none"
        filter={b.status === 'burning' && !lite ? 'url(#heatHaze)' : undefined} style={{ pointerEvents: 'none' }} />
      {/* rooms: power failing, then fire moving through them */}
      <WindowLayer b={b} ox={box.x} oy={box.y} s={s} lite={lite} />
      {b.status === 'burning' && (() => {
        // fire builds over time: first smoke from the windows, then flames that spread across the roof
        const p = Math.min(1, b.burnProgress ?? 0);
        const grow = Math.min(1, p / 0.55);
        const nRoof = Math.max(1, Math.round(1 + grow * 7));
        const flameScale = (0.45 + grow * 0.9) * (heavy ? 1.5 : 1);
        return (
          <g style={{ pointerEvents: 'none' }}>
            <g filter={lite ? undefined : 'url(#flameWarp)'} style={lite ? undefined : { mixBlendMode: 'screen' }}>
            <ellipse cx={rx} cy={ry} rx={(0.433 * (b.w + b.h) + 24) * (heavy ? 1.35 : 1)} ry={(0.25 * (b.w + b.h) + 30) * (heavy ? 1.35 : 1)} fill="url(#roofGlow)"
              style={{ opacity: 0.25 + grow * 0.75, transition: 'opacity 1.5s ease', ...(lite ? {} : { mixBlendMode: 'screen' as const }) }} />
            {/* early smoke leaking from the facade */}
            {facePts.slice(0, 4).map(([px, py], i) => (
              <circle key={`ws${i}`} cx={px} cy={py} r="6" fill="url(#smokeDark)" style={{ opacity: Math.max(0.15, 1 - grow * 0.6) }}>
                <animate attributeName="r" values="4;22" dur="3.4s" begin={`${-i * 0.8}s`} repeatCount="indefinite" />
                <animateMotion path="M0 0 C -12 -30 -40 -55 -80 -70" dur="3.4s" begin={`${-i * 0.8}s`} repeatCount="indefinite" />
              </circle>
            ))}
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
            {[0, 1, 2, ...(heavy ? [3, 4] : [])].map((i) => (
              <circle key={i} cx={roofPts[(i * 2) % 8][0]} cy={ry - 12} r="10" fill="url(#smokeDark)">
                <animate attributeName="r" values={heavy ? '12;56' : '8;38'} dur="5s" begin={`${-i * 1.2}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="0;0.8;0" dur="5s" begin={`${-i * 1.2}s`} repeatCount="indefinite" />
                <animateMotion path="M0 0 C -30 -40 -80 -70 -150 -95" dur="5s" begin={`${-i * 1.2}s`} repeatCount="indefinite" />
              </circle>
            ))}
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

export const Town = memo(function Town({ sim, buildings, fireCells, pack, selectedId, onSelect, svgRef, tagScale = 1, lite = false, units = [] }: TownProps) {
  const P = PALETTES[pack];
  // plants only depend on building footprints, which never change during a run
  const footprintKey = buildings.map((b) => `${b.x},${b.y},${b.w},${b.h}`).join('|');
  const plants = useMemo(
    () => generatePlants(footprintKey.split('|').map((s) => { const [x, y, w, h] = s.split(',').map(Number); return { x, y, w, h }; })),
    [footprintKey],
  );
  const shelter = buildings.find((b) => b.kind === 'shelter');

  const cellState = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of fireCells) if (c.state) m.set(c.y * 1000 + c.x, c.state);
    return m;
  }, [fireCells]);
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
  const [gsx, gsy] = project(fcx, fcy);
  const [wx, wy] = windVector(sim.windDirDeg);
  const [wsx, wsy] = projectVec(wx, wy);
  const smokePath = `M0 0 C ${wsx * 140} ${wsy * 140 - 70} ${wsx * 340} ${wsy * 340 - 140} ${wsx * 580} ${wsy * 580 - 200}`;

  // ---------------- billboards sorted back-to-front by map depth (x + y)
  const items: { depth: number; key: string; node: ReactNode }[] = [];
  for (const [i, p] of plants.entries()) {
    const st = cellState.get(Math.floor(p.y / CELL) * 1000 + Math.floor(p.x / CELL)) ?? 0;
    if (p.type === 'shrub' && st === 2) continue;
    const [px, py] = project(p.x, p.y);
    const type = st === 2 ? 'snag' : p.type;
    // deterministic size jitter so the rows of trees do not look stamped
    const sc = (type === 'shrub' ? 0.8 : type === 'palm' ? 1.12 : 0.92) + ((i * 37) % 10) / 40;
    items.push({
      depth: p.x + p.y,
      key: `p${i}`,
      node: (
        <image
          href={propUrl(type, pack)}
          x={px - PROP_BOX.ax * sc}
          y={py - PROP_BOX.ay * sc}
          width={PROP_BOX.w * sc}
          height={PROP_BOX.h * sc}
          preserveAspectRatio="none"
          style={{ pointerEvents: 'none' }}
        />
      ),
    });
  }
  for (const b of buildings) {
    items.push({
      depth: b.x + b.w / 2 + b.y + b.h / 2,
      key: `b${b.id}`,
      node: <BuildingSprite b={b} pack={pack} selected={selectedId === b.id} onSelect={onSelect} lite={lite} />,
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
      depth: mx + my,
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
      depth: mx + my,
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
      <StaticGround P={P} lite={lite} />

      {/* ground-level dynamic layer: fire cells, rings, routes */}
      <g transform={GROUND_MATRIX}>
        {fireOn && <circle cx={fcx} cy={fcy} r="300" fill="url(#groundGlow)" opacity={P.glowOp} />}
        {/* settled ash */}
        <path d={cellPath(burned)} fill="url(#ash)" filter={lite ? undefined : 'url(#blur2)'} opacity="0.92" />
        {/* recently burnt: ash fades in under embers that dim and go out */}
        <g filter={lite ? undefined : 'url(#blur2)'}>
          {cooling.map((c) => (
            <g key={`k${c.id}`}>
              <rect className="cell-ash" x={c.x * CELL} y={c.y * CELL} width={CELL} height={CELL} fill="url(#ash)" />
              <rect className="cell-cool" x={c.x * CELL} y={c.y * CELL} width={CELL} height={CELL} fill="#B8320E" />
            </g>
          ))}
        </g>
        {/* burning front: each cell catches a moment apart, flares, then settles into a flicker */}
        <g filter={lite ? undefined : 'url(#blur2)'}>
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
          <path key={`e${b.id}`} d={'M' + evacRoute(b, shelter).map(([x, y]) => `${x} ${y}`).join(' L')} stroke={STATUS_COLORS.green} strokeWidth="5" fill="none" strokeDasharray="12 10" strokeLinecap="round" strokeLinejoin="round">
            <animate attributeName="stroke-dashoffset" from="44" to="0" dur="1.2s" repeatCount="indefinite" />
          </path>
        ))}
      </g>

      {/* cars, strolling residents, evacuation columns and vans */}
      <StreetLife buildings={buildings} phase={sim.phase} />

      {/* depth-sorted world */}
      {items.map((it) => <g key={it.key}>{it.node}</g>)}

      {/* fire units sit on top so engines at a building front and their water are never hidden */}
      <FireUnits units={units} buildings={buildings} tickSeconds={TICK_SECONDS} />

      {/* smoke, embers, fire light */}
      {fireOn && (
        <g style={{ pointerEvents: 'none' }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <circle key={i} cx={gsx} cy={gsy} r="30" fill="url(#smokePlume)">
              <animate attributeName="r" values="26;120" dur="11s" begin={`${-i * 1.8}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values={`0;${P.smokeOp};0`} dur="11s" begin={`${-i * 1.8}s`} repeatCount="indefinite" />
              <animateMotion path={smokePath} dur="11s" begin={`${-i * 1.8}s`} repeatCount="indefinite" />
            </circle>
          ))}
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <circle key={`e${i}`} cx={gsx + (i - 3) * 14} cy={gsy + (i % 3) * 10} r={1.3 + (i % 3) * 0.3} fill="#FFC46B">
              <animateMotion path={`M0 0 C ${wsx * 60} ${-50 - i * 6} ${wsx * 160} ${-70} ${wsx * (220 + i * 30)} -30`} dur={`${3 + (i % 3)}s`} begin={`${-i * 0.6}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;1;0" dur={`${3 + (i % 3)}s`} begin={`${-i * 0.6}s`} repeatCount="indefinite" />
            </circle>
          ))}
          <ellipse cx={gsx} cy={gsy} rx="460" ry="300" fill="url(#fireGlow)" opacity={P.glowOp * (lite ? 0.7 : 1)} style={lite ? undefined : { mixBlendMode: 'screen' }}>
            <animate attributeName="rx" values="440;470;450;440" dur="2.6s" repeatCount="indefinite" />
          </ellipse>
        </g>
      )}

      {/* waypoint markers: stem + numbered diamond + halo lettering (no pills) */}
      <Markers buildings={buildings} phase={sim.phase} scale={tagScale} selectedId={selectedId} />
    </svg>
  );
});
