// Room-by-room effects on a building's windows: failing power (flicker, rooms going dark) as the
// fire approaches, then fire moving through the rooms, top floors first, once the building ignites.
// Window outlines come from Blender (blender/build_sprites.py --export-windows) in sprite-frame units.
import windowsJson from './windows.json';
import type { Building } from './types';

type Win = number[]; // x1,y1,x2,y2,x3,y3,x4,y4,floor,face
const WINDOWS = windowsJson as Record<string, Win[]>;

/** Stable 0..1 per window so each room behaves the same from frame to frame. */
const hash = (kind: string, i: number) => (((i + 7) * 2654435761 + kind.length * 40503) % 1000) / 1000;

type RoomState = 'ok' | 'flicker' | 'dark' | 'fire';

function roomState(b: Building, h: number, floorShare: number): RoomState {
  if (b.status === 'lost') return 'ok';
  if (b.status === 'burning') {
    const p = Math.min(1, b.burnProgress ?? 0);
    // heat rises: upper floors catch first, then the fire works down through the building
    const key = h * 0.55 + (1 - floorShare) * 0.45;
    const fireReach = (b.damage ?? 0) >= 2 ? 0.9 : Math.min(0.95, 0.08 + p * 1.7);
    if (key < fireReach) return 'fire';
    if (h < 0.45 + p) return 'dark';
    return 'flicker';
  }
  const near = b.status === 'behind' || (b.fireEtaMin >= 0 && b.fireEtaMin < 60);
  if (!near) return 'ok';
  if (h < 0.3) return 'flicker';
  if (h < 0.45) return 'dark';
  return 'ok';
}

interface Props { b: Building; ox: number; oy: number; s: number; lite: boolean }

export function WindowLayer({ b, ox, oy, s, lite }: Props) {
  const wins = WINDOWS[b.kind];
  if (!wins || b.status === 'lost') return null;
  const maxFloor = Math.max(1, ...wins.map((w) => w[8]));
  const items = wins.map((w, i) => {
    const h = hash(b.kind, i);
    const st = roomState(b, h, w[8] / maxFloor);
    return { w, i, h, st };
  }).filter((x) => x.st !== 'ok');
  if (!items.length) return null;

  const pts = (w: Win) => [0, 2, 4, 6].map((k) => `${(ox + w[k] * s).toFixed(1)},${(oy + w[k + 1] * s).toFixed(1)}`).join(' ');

  return (
    <g style={{ pointerEvents: 'none' }}>
      {items.map(({ w, i, h, st }) => {
        if (st === 'dark') return <polygon key={i} className="win-dark" points={pts(w)} fill="#06080C" />;
        if (st === 'flicker') {
          if (lite && h > 0.2) return <polygon key={i} points={pts(w)} fill="#06080C" opacity="0.5" />;
          return <polygon key={i} className="win-flicker" points={pts(w)} fill="#06080C"
            style={{ animationDuration: `${1.4 + h * 2.4}s`, animationDelay: `${-h * 4}s` }} />;
        }
        // fire in the room: a hot base, rolling bands of flame, and on some windows a tongue licking out
        const topX = ox + ((w[4] + w[6]) / 2) * s;
        const topY = oy + ((w[5] + w[7]) / 2) * s;
        return (
          <g key={i}>
            <polygon className="win-fire" points={pts(w)} fill="url(#winFire)" style={{ animationDuration: `${0.7 + h * 0.9}s`, animationDelay: `${-h * 2}s` }} />
            {!lite && <polygon points={pts(w)} fill="url(#winWave)" opacity="0.85" />}
            {!lite && h > 0.55 && w[9] === 0 && (
              <g transform={`translate(${topX} ${topY + 2 * s})`}>
                <g className="flame-grow" style={{ animationDelay: `${Math.round(h * 900)}ms` }}>
                  <use href={h > 0.8 ? '#flA' : '#flC'} transform={`scale(${0.42 * Math.max(0.8, s)})`} />
                </g>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}
