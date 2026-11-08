// Static map geometry (from the spec / Main.dc mockup) and sprite metadata.
import type { Building, BuildingKind, BuildingStatus, Pack } from './types';

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

export function propUrl(type: 'oak' | 'palm' | 'shrub' | 'snag', pack: Pack): string {
  return `${import.meta.env.BASE_URL}sprites/prop_${type}_${type === 'snag' ? 'lost' : pack}.webp`;
}

export function spriteScale(b: Pick<Building, 'kind' | 'w' | 'h'>): number {
  const s = SPRITE[b.kind];
  return Math.min(1.15, Math.max(0.7, Math.sqrt((b.w * b.h) / (s.W * s.D))));
}

export function spriteVariant(pack: Pack, status: BuildingStatus): string {
  if (status === 'burning') return 'burning';
  if (status === 'lost') return 'lost';
  return pack;
}

export function spriteUrl(kind: BuildingKind, variant: string): string {
  return `${import.meta.env.BASE_URL}sprites/${kind}_${variant}.webp`;
}

// ---------------------------------------------------------------- vegetation (deterministic)
export interface Plant { x: number; y: number; type: 'oak' | 'palm' | 'shrub' }

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
  while (n < 46 && tries++ < 3000) {
    const x = rnd() * 1000;
    const y = rnd() * 620;
    if (inHills(x, y) || inHills(x + 30, y + 30) || isLot(x, y)) continue;
    if (SIDEWALKS.some((r) => x > r.x - 6 && x < r.x + r.w + 6 && y > r.y - 6 && y < r.y + r.h + 6)) continue;
    if (blocks.some(([a, b, c, d]) => x > a && x < c && y > b && y < d)) continue;
    if (out.some((p) => p.type !== 'shrub' && Math.hypot(p.x - x, p.y - y) < 34)) continue;
    out.push({ x, y, type: n % 3 === 1 ? 'palm' : 'oak' });
    n++;
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
