// Wind, drawn in the world: thin gust lines that drift across the town in the projected wind direction
// (the same direction the smoke and embers lean), faster and denser the harder it blows. A small
// compass in the map controls carries the exact reading.
import { memo, type CSSProperties } from 'react';
import type { Pack, Phase } from './types';
import { MAP_H, MAP_W, project, windScreen } from './iso';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** stable 0..1 per (i, k) */
const rnd = (i: number, k: number) => ((((i + 1) * 2654435761 + k * 40503) >>> 0) % 10007) / 10007;

const STREAK_COLOR: Record<Pack, string> = { night: '#D6E6FF', dusk: '#FFF4DE', maquette: '#6F675E' };

interface StreakProps { dirDeg: number; mph: number; pack: Pack; phase: Phase; lite: boolean; rotation: number }

export const WindStreaks = memo(function WindStreaks({ dirDeg, mph, pack, phase, lite }: StreakProps) {
  const { deg } = windScreen(dirDeg); // reads the current view rotation (the rotation prop re-renders this)
  const strength = Math.min(1.5, Math.max(0.25, mph / 40));
  const n = lite ? 9 : Math.round(Math.min(24, Math.max(7, 6 + mph * 0.32))); // 19 at 40 mph
  const speed = 40 + mph * 4; // screen units per second: 200 at 40 mph
  const travel = 340;
  const peak = (phase === 'fire' ? 0.72 : 0.55) * Math.min(1, 0.55 + strength * 0.45);
  const streaks = Array.from({ length: n }, (_, i) => {
    // spread over the board and a margin around it, a little above the ground
    const [px, py] = project(-60 + rnd(i, 1) * (MAP_W + 120), -60 + rnd(i, 2) * (MAP_H + 120), 14 + rnd(i, 3) * 60);
    const L = 46 + rnd(i, 4) * 64 * (0.6 + strength * 0.4);
    const a = 1.5 + rnd(i, 5) * 3.5;
    const dur = (travel / speed) * (0.85 + rnd(i, 6) * 0.35);
    const d = rnd(i, 8) < 0.22
      // some gusts curl at the head
      ? `M0 0 C ${L * 0.3} ${-a} ${L * 0.6} ${a} ${L} 0 c 7 -1 10 -7 5 -10 c -4 -2 -7 2 -4 5`
      : `M0 0 C ${L * 0.3} ${-a} ${L * 0.6} ${a} ${L} 0`;
    return { i, px, py, d, dur, delay: -rnd(i, 7) * dur, w: 1.3 + rnd(i, 9) * 1.2 };
  });
  // a few broad, faint ribbons of moving air under the streaks
  const ribbons = lite ? [] : [0, 1, 2].map((i) => {
    const [px, py] = project(120 + i * 330 + rnd(i, 11) * 80, 120 + rnd(i, 12) * 380, 30);
    return { i, px, py, dur: ((travel * 1.6) / speed) * (1 + i * 0.15), delay: -rnd(i, 13) * 4 };
  });
  return (
    <g className="wind-field" aria-hidden="true" style={{ pointerEvents: 'none' }}>
      <defs>
        <linearGradient id="windGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={STREAK_COLOR[pack]} stopOpacity="0" />
          <stop offset="0.6" stopColor={STREAK_COLOR[pack]} stopOpacity="1" />
          <stop offset="1" stopColor={STREAK_COLOR[pack]} stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {ribbons.map((r) => (
        <g key={`r${r.i}`} transform={`translate(${r.px.toFixed(1)} ${r.py.toFixed(1)}) rotate(${deg.toFixed(1)})`}>
          <path className="wind-streak" d="M0 0 C 60 -8 120 8 190 0" stroke="url(#windGrad)" strokeWidth="5"
            style={{ '--d': `${travel * 1.6}px`, '--o': (peak * 0.22).toFixed(3), animationDuration: `${r.dur.toFixed(2)}s`, animationDelay: `${r.delay.toFixed(2)}s` } as CSSProperties} />
        </g>
      ))}
      {streaks.map((s) => (
        <g key={s.i} transform={`translate(${s.px.toFixed(1)} ${s.py.toFixed(1)}) rotate(${deg.toFixed(1)})`}>
          <path className="wind-streak" d={s.d} stroke="url(#windGrad)" strokeWidth={s.w.toFixed(2)}
            style={{ '--d': `${travel}px`, '--o': peak.toFixed(3), animationDuration: `${s.dur.toFixed(2)}s`, animationDelay: `${s.delay.toFixed(2)}s` } as CSSProperties} />
        </g>
      ))}
    </g>
  );
});

/** Compact wind reading for the map controls: an arrow in the on-screen wind direction, heading and speed. */
export function WindCompass({ dirDeg, mph }: { dirDeg: number; mph: number }) {
  const { deg } = windScreen(dirDeg);
  const name = compass(dirDeg);
  return (
    <div className="wind-cell" role="img" aria-label={`Wind toward ${name} at ${mph} mph`} title={`Wind toward ${name} at ${mph} mph`}>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${deg.toFixed(1)}deg)` }}>
        <path d="M3 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <b>{name}</b>
      <small>{mph} mph</small>
    </div>
  );
}
