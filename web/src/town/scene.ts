// Static map geometry (from the spec / Main.dc mockup) and sprite metadata.
import type { Building, BuildingKind, BuildingStatus, Pack } from './types';
import { project } from './iso';

export const HILLS_PATH =
  'M560,0 L1000,0 L1000,285 C930,255 880,218 820,206 C760,196 700,152 640,122 C608,102 584,62 560,0 Z';
export const HILLS_EDGE =
  'M1000,285 C930,255 880,218 820,206 C760,196 700,152 640,122 C608,102 584,62 560,0';
const HILLS_POLY: [number, number][] = [
  [560, 0], [1000, 0], [1000, 285], [930, 255], [880, 218], [820, 206], [760, 196],
  [700, 152], [640, 122], [608, 102], [584, 62],
];

export function inHills(x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = HILLS_POLY.length - 1; i < HILLS_POLY.length; j = i++) {
    const [xi, yi] = HILLS_POLY[i];
    const [xj, yj] = HILLS_POLY[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Rect { x: number; y: number; w: number; h: number }

export const ROADS: Rect[] = [
  { x: 0, y: 430, w: 1000, h: 36 },
  { x: 360, y: 0, w: 32, h: 620 },
  { x: 392, y: 214, w: 608, h: 22 },
];
export const SIDEWALKS: Rect[] = [
  { x: 0, y: 424, w: 1000, h: 48 },
  { x: 354, y: 0, w: 44, h: 620 },
  { x: 392, y: 208, w: 608, h: 34 },
];
export const ROAD_LINES = 'M0 448 H1000 M376 0 V620 M392 225 H1000';
export const LOTS: Rect[] = [
  { x: 600, y: 490, w: 140, h: 92 },
  { x: 20, y: 482, w: 104, h: 120 },
];
export const PARK: Rect = { x: 24, y: 24, w: 310, h: 196 };
export const LAMPS: [number, number][] = [
  [80, 448], [230, 448], [520, 448], [680, 448], [840, 448], [960, 448],
  [376, 110], [376, 300], [376, 560], [520, 225], [760, 225], [670, 536],
];

export function onRoad(x: number, y: number): boolean {
  return ROADS.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

// ---------------------------------------------------------------- sprites
/** Footprint (SVG units) and roof height each Blender sprite was modelled at. */
export const SPRITE: Record<BuildingKind, { W: number; D: number; roof: number; tag: number }> = {
  senior: { W: 150, D: 75, roof: 56, tag: 70 },
  apartments: { W: 120, D: 90, roof: 70, tag: 84 },
  office: { W: 128, D: 64, roof: 70, tag: 96 },
  shelter: { W: 140, D: 60, roof: 30, tag: 46 },
  homes: { W: 280, D: 40, roof: 25, tag: 34 },
};
export const SPRITE_BOX = { w: 520, h: 380, ax: 220, ay: 220 }; // must match BOX_W/H + ANCHOR in blender/build_sprites.py

/** Vegetation sprite frame (must match PROP_BOX in blender/build_sprites.py); anchor = trunk base. */
export const PROP_BOX = { w: 176, h: 110, ax: 36, ay: 62 };

export function propUrl(type: 'oak' | 'palm' | 'shrub' | 'snag' | 'euc', pack: Pack): string {
  return `${import.meta.env.BASE_URL}sprites/prop_${type}_${type === 'snag' ? 'lost' : pack}.webp`;
}

export function spriteScale(b: Pick<Building, 'kind' | 'w' | 'h'>): number {
  const s = SPRITE[b.kind];
  return Math.min(1.15, Math.max(0.7, Math.sqrt((b.w * b.h) / (s.W * s.D))));
}

/** Which render to show: the look, or a fire damage stage (burning, gutted, collapsed). */
export function spriteVariant(pack: Pack, status: BuildingStatus, damage = 0): string {
  if (status === 'lost') return 'lost';
  if (status === 'burning') return damage >= 2 ? 'gutted' : 'burning';
  return pack;
}

/** The stage a building was in just before this one, so the map can cross-fade between them. */
export function previousVariant(pack: Pack, variant: string): string | null {
  if (variant === 'burning') return pack;
  if (variant === 'gutted') return 'burning';
  if (variant === 'lost') return 'gutted';
  return null;
}

/** The Blender ground plate (blender/build_ground.py): where it sits in the view box, and which file. */
export const GROUND_PLATE = { x: 0, y: 96, w: 1440, h: 872 };
export function groundUrl(pack: Pack, lite: boolean): string {
  return `${import.meta.env.BASE_URL}sprites/ground_${pack}${lite ? '_lite' : ''}.webp`;
}

export function spriteUrl(kind: BuildingKind, variant: string): string {
  return `${import.meta.env.BASE_URL}sprites/${kind}_${variant}.webp`;
}

// ---------------------------------------------------------------- vegetation (deterministic)
export interface Plant { x: number; y: number; type: 'oak' | 'palm' | 'shrub' | 'euc' }

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function generatePlants(buildings: Pick<Building, 'x' | 'y' | 'w' | 'h'>[]): Plant[] {
  const rnd = rng(7);
  const out: Plant[] = [];
  let tries = 0;
  while (out.filter((p) => p.type === 'shrub').length < 46 && tries++ < 600) {
    const x = 560 + rnd() * 440;
    const y = rnd() * 285;
    if (inHills(x, y)) out.push({ x, y, type: 'shrub' });
  }
  const blocks = buildings.map((b) => [b.x - 30, b.y - 30, b.x + b.w + 30, b.y + b.h + 30]);
  const isLot = (x: number, y: number) => LOTS.some((l) => x > l.x - 6 && x < l.x + l.w + 6 && y > l.y - 6 && y < l.y + l.h + 6);
  let n = 0;
  tries = 0;
  while (n < 78 && tries++ < 5000) {
    const x = rnd() * 1000;
    const y = rnd() * 620;
    if (inHills(x, y) || inHills(x + 30, y + 30) || isLot(x, y)) continue;
    if (SIDEWALKS.some((r) => x > r.x - 6 && x < r.x + r.w + 6 && y > r.y - 6 && y < r.y + r.h + 6)) continue;
    if (blocks.some(([a, b, c, d]) => x > a && x < c && y > b && y < d)) continue;
    if (out.some((p) => p.type !== 'shrub' && Math.hypot(p.x - x, p.y - y) < 28)) continue;
    // Altadena mix: oaks, eucalyptus windbreaks near the hills, palms in the yards
    const nearHills = inHills(x + 90, y + 90);
    out.push({ x, y, type: nearHills && n % 2 === 0 ? 'euc' : n % 4 === 1 ? 'palm' : n % 4 === 3 ? 'euc' : 'oak' });
    n++;
  }
  // palm-lined avenues: a tall fan palm every 64 units along both main streets
  const clear = (x: number, y: number) =>
    !blocks.some(([a, b, c, d]) => x > a + 18 && x < c - 18 && y > b + 18 && y < d - 18) && !isLot(x, y) && !inHills(x, y);
  for (let x = 30; x < 990; x += 64) {
    if (x > 330 && x < 420) continue;
    for (const y of [419, 477]) if (clear(x, y)) out.push({ x, y, type: 'palm' });
  }
  for (let y = 30; y < 600; y += 64) {
    if (y > 400 && y < 490) continue;
    for (const x of [349, 403]) if (clear(x, y) && !(x === 403 && y > 200 && y < 250)) out.push({ x, y, type: 'palm' });
  }
  return out;
}

/** Route from a building's front door to Shelter A along the roads (map space). */
export function evacRoute(b: Building, shelter: Building | undefined): [number, number][] {
  const sx = shelter ? shelter.x + shelter.w / 2 : 510;
  const sy = shelter ? shelter.y : 505;
  const doorX = b.x + b.w / 2;
  const doorY = b.y + b.h + 2;
  const roadY = 448;
  if (doorY < 214) {
    // north of the secondary road: drop to it, run to the main avenue, then down
    return [[doorX, doorY], [doorX, 225], [376, 225], [376, roadY], [sx, roadY], [sx, sy]];
  }
  if (doorY > 466) {
    const top = b.y - 2;
    return [[doorX, top], [doorX, roadY], [sx, roadY], [sx, sy]];
  }
  return [[doorX, doorY], [doorX, roadY], [sx, roadY], [sx, sy]];
}

/** Fire units wait in the office parking lot (map space) and drive the roads to a building. */
export const STAGING: [number, number] = [72, 540];

// Driving lanes (right-hand traffic): the main road (y 430..466), the cross street (x 360..392)
// and the hillside street (y 214..236, east of the cross street).
const LANE = { mainE: 457, mainW: 439, crossS: 383, crossN: 369, hillE: 220, hillW: 230 };

/** Which street a building is served from: the one whose edge is closest to its footprint. */
function servingRoad(b: Pick<Building, 'x' | 'y' | 'w' | 'h'>): 0 | 1 | 2 {
  const gap = (r: Rect) => {
    const dx = Math.max(r.x - (b.x + b.w), b.x - (r.x + r.w), 0);
    const dy = Math.max(r.y - (b.y + b.h), b.y - (r.y + r.h), 0);
    return Math.hypot(dx, dy);
  };
  const d = ROADS.map(gap);
  return d.indexOf(Math.min(...d)) as 0 | 1 | 2;
}

/**
 * Fire units leave the staging lot and drive the streets to the curb in front of the building,
 * always in the right lane and never across lawns or through other buildings.
 */
/** Screen box of a building (footprint up to its roof). */
function screenBox(o: Pick<Building, 'kind' | 'x' | 'y' | 'w' | 'h'>) {
  const roof = SPRITE[o.kind].roof * spriteScale(o);
  const pts = [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]].flatMap(([x, y]) => [project(x, y, 0), project(x, y, roof)]);
  return { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) };
}

/**
 * The curb spot along the building's street that is nearest its middle and not hidden behind
 * another building, so the engine (and its hoses) can be seen from the camera.
 */
function parkAlong(b: Building, all: Building[], road: 0 | 1 | 2, lane: number, lo: number, hi: number, mid: number): number {
  const front = all.filter((o) => o.id !== b.id);
  const visible = (t: number) => {
    const [x, y] = road === 1 ? [lane, t] : [t, lane];
    const [ex, ey] = project(x, y);
    const box = { x0: ex - 22, x1: ex + 22, y0: ey - 20, y1: ey + 4 };
    return !front.some((o) => {
      if (o.x + o.w / 2 + o.y + o.h / 2 <= x + y) return false; // behind the engine: drawn first
      const r = screenBox(o);
      return box.x0 < r.x1 && box.x1 > r.x0 && box.y0 < r.y1 && box.y1 > r.y0;
    });
  };
  const span = Math.max(mid - lo, hi - mid) + 140;
  for (let d = 0; d <= span; d += 8) {
    for (const t of [mid - d, mid + d]) if (t >= lo - 140 && t <= hi + 140 && visible(t)) return t;
  }
  return mid;
}

export function unitRoute(b: Building, all: Building[] = []): [number, number][] {
  const road = servingRoad(b);
  const cx = road === 1 ? b.x + b.w / 2 : parkAlong(b, all, road, road === 0 ? LANE.mainE : LANE.hillE, b.x, b.x + b.w, b.x + b.w / 2);
  const cy = road === 1 ? parkAlong(b, all, 1, LANE.crossN, b.y, b.y + b.h, b.y + b.h / 2) : b.y + b.h / 2;
  const out: [number, number][] = [STAGING, [STAGING[0], LANE.mainE]];
  if (road === 0) {
    const x = Math.min(990, Math.max(20, cx));
    out.push([x, x >= STAGING[0] ? LANE.mainE : LANE.mainW]);
    return out;
  }
  // up the cross street (turn left from the eastbound lane into the northbound lane)
  out.push([LANE.crossN, LANE.mainE]);
  if (road === 1) {
    const y = Math.min(600, Math.max(20, cy));
    out.push([LANE.crossN, y]);
    return out;
  }
  out.push([LANE.crossN, LANE.hillE], [Math.min(990, Math.max(410, cx)), LANE.hillE]);
  return out;
}

export function routeLength(pts: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

/** San Gabriel Mountains backdrop: three hazy ridgelines behind the town (screen space). */
export function ridgePaths(): string[] {
  const rng2 = (seed: number) => { let t = seed; return () => (t = (t * 16807) % 2147483647) / 2147483647; };
  const layers: [number, number, number, number][] = [
    // base height at left, base at right, amplitude, seed
    [250, 520, 120, 3],
    [300, 590, 95, 11],
    [360, 650, 70, 23],
  ];
  return layers.map(([y0, y1, amp, seed]) => {
    const r = rng2(seed);
    let d = `M -1400 ${y0 + 200}`;
    let x = -1400;
    let wave = 0;
    while (x <= 2900) {
      const t = Math.min(1, Math.max(0, (x + 40) / 1540));
      wave = wave * 0.55 + (r() - 0.5) * 0.9;
      const ridge = y0 + (y1 - y0) * t - amp * (0.55 + 0.45 * Math.sin(t * 7 + seed) + wave * 0.6);
      d += ` L ${x.toFixed(0)} ${ridge.toFixed(0)}`;
      x += 18 + r() * 26;
    }
    return d + ` L 2900 ${y1 + 330} L -1400 ${y1 + 330} Z`;
  });
}
