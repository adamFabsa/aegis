// Static map geometry (from the spec / Main.dc mockup) and sprite metadata.
import type { Building, BuildingKind, BuildingStatus, Pack } from './types';
import { project, projectRaw, rot, rotRect, viewRotation } from './iso';

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
export function groundUrl(pack: Pack, lite: boolean, rotation = 0): string {
  return `${import.meta.env.BASE_URL}sprites/ground_${pack}${rotation ? `_r${rotation}` : ''}${lite ? '_lite' : ''}.webp`;
}

export function spriteUrl(kind: BuildingKind, variant: string, rotation = 0): string {
  return `${import.meta.env.BASE_URL}sprites/${kind}_${variant}${rotation ? `_r${rotation}` : ''}.webp`;
}

// ---------------------------------------------------------------- vegetation (deterministic)
export interface Plant { x: number; y: number; type: 'oak' | 'palm' | 'shrub' | 'euc' }

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** `seed`: 7 is the demo map's scatter; each scenario passes its own number so the trees and brush move. */
export function generatePlants(buildings: Pick<Building, 'x' | 'y' | 'w' | 'h'>[], seed = 7): Plant[] {
  const rnd = rng(Math.max(1, Math.floor(seed)) % 2147483647);
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

// ---------------------------------------------------------------- fire engines: where they park, how they get there
/** Fire units wait in the office parking lot (map space) and drive the roads to a building. */
export const STAGING: [number, number] = [72, 540];

// Driving lanes: the main road (y 430..466), the cross street (x 360..392) and the hillside street
// (y 214..236, east of the cross street). Each street has two lanes, one along each curb.
const LANE = { mainE: 457, mainW: 439, crossS: 383, crossN: 369, hillE: 220, hillW: 230 };
const CROSSINGS: [number, number][] = [[376, 448], [376, 225]];

/** A place an engine can stand: a point in the lane along one curb of a street (0 main, 1 cross, 2 hillside). */
export interface Curb {
  x: number;
  y: number;
  road: 0 | 1 | 2;
  /** no place clear of the buildings was found (never on the town's layout): a building may cover the engine */
  hidden?: boolean;
}

/** Centre-to-centre distance two parked engines keep (an engine is about 34 map units long). */
export const ENGINE_GAP = 44;

/** Every place along the streets an engine could stop, 6 units apart, clear of the intersections. */
const CURBS: Curb[] = (() => {
  const out: Curb[] = [];
  const clear = (x: number, y: number) => CROSSINGS.every(([cx, cy]) => Math.abs(x - cx) > 40 || Math.abs(y - cy) > 40);
  // (the main road only from x 130: engines leave the lot eastbound and never need to turn back west)
  for (let t = 130; t <= 976; t += 6) for (const y of [LANE.mainW, LANE.mainE]) if (clear(t, y)) out.push({ x: t, y, road: 0 });
  for (let t = 22; t <= 598; t += 6) for (const x of [LANE.crossN, LANE.crossS]) if (clear(x, t)) out.push({ x, y: t, road: 1 });
  for (let t = 418; t <= 976; t += 6) for (const y of [LANE.hillE, LANE.hillW]) if (clear(t, y)) out.push({ x: t, y, road: 2 });
  return out;
})();

/** The lane along the curb on the building's side of a street. */
function nearLane(b: Pick<Building, 'x' | 'y' | 'w' | 'h'>, road: 0 | 1 | 2): number {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (road === 0) return cy < 448 ? LANE.mainW : LANE.mainE;
  if (road === 1) return cx < 376 ? LANE.crossN : LANE.crossS;
  return cy < 225 ? LANE.hillE : LANE.hillW;
}

/** The building as drawn, as a screen polygon: its footprint (or the sprite's, if larger) up to the roof. */
function silhouette(o: Pick<Building, 'kind' | 'x' | 'y' | 'w' | 'h'>): [number, number][] {
  const s = spriteScale(o);
  const sp = SPRITE[o.kind];
  const w = Math.max(o.w, sp.W * s) + 2;
  const h = Math.max(o.h, sp.D * s) + 2;
  const r = rotRect({ x: o.x + o.w / 2 - w / 2, y: o.y + o.h / 2 - h / 2, w, h });
  const z = sp.roof * s + 6; // roof plant, parapets
  return [
    projectRaw(r.x, r.y, z), projectRaw(r.x + r.w, r.y, z), projectRaw(r.x + r.w, r.y, 0),
    projectRaw(r.x + r.w, r.y + r.h, 0), projectRaw(r.x, r.y + r.h, 0), projectRaw(r.x, r.y + r.h, z),
  ];
}

/** Screen box of a parked engine around its ground point (the sprite's body is about ±21 wide, 24 up, 11 down). */
const ENGINE_BOX = { l: -22, r: 22, t: -26, b: 12 };

/** Does the screen box overlap the convex polygon? (separating axes: the box's two, then each polygon edge) */
function boxHitsHull(x0: number, y0: number, x1: number, y1: number, hull: [number, number][]): boolean {
  const xs = hull.map((p) => p[0]);
  const ys = hull.map((p) => p[1]);
  if (Math.max(...xs) <= x0 || Math.min(...xs) >= x1 || Math.max(...ys) <= y0 || Math.min(...ys) >= y1) return false;
  const box: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % hull.length];
    const nx = by - ay;
    const ny = ax - bx;
    const hp = hull.map(([x, y]) => x * nx + y * ny);
    const bp = box.map(([x, y]) => x * nx + y * ny);
    if (Math.max(...hp) <= Math.min(...bp) || Math.max(...bp) <= Math.min(...hp)) return false;
  }
  return true;
}

/**
 * Is (x, y) in front of one of the building's visible faces? In every view rotation those are the view's front (+y)
 * and side (+x); the corner between them counts, the far ends of the faces only a little way past the corners.
 */
function facesCamera(b: Pick<Building, 'x' | 'y' | 'w' | 'h'>, x: number, y: number): boolean {
  const r = rotRect(b);
  const [vx, vy] = rot(x, y);
  return (vy >= r.y + r.h + 4 && vx >= r.x - r.w * 0.2) || (vx >= r.x + r.w + 4 && vy >= r.y - r.h * 0.2);
}

/**
 * Roughly where each building's name tag sits on screen at the default zoom (markers.tsx: a diamond and two lines
 * of text up the stem from the roof, about 1.2x). Tags are drawn above everything, engines included.
 */
function tagBoxes(all: Pick<Building, 'kind' | 'x' | 'y' | 'w' | 'h' | 'name'>[]): [number, number, number, number][] {
  const s = 1.2;
  return all.map((b) => {
    const [x, roofY] = project(b.x + b.w / 2, b.y + b.h / 2, (SPRITE[b.kind].tag - 6) * spriteScale(b));
    const y = roofY - 34 * s;
    const w = 22 + Math.max(b.name.length * 7.4, 120);
    return [x - 16 * s, y - 16 * s, x + w * s, y + 18 * s];
  });
}

/**
 * The places an engine sent to b could stand, best first: in front of a visible face, close, and clear of every
 * building on screen (engines are drawn under the buildings, so any building over the engine would hide it, b itself
 * too; and a parked engine is drawn again above the town, which is only right where no building overlaps it), and
 * if it can be, of the name tags.
 */
function curbChoices(b: Building, all: Building[]): { c: Curb; score: number }[] {
  const hulls = all.map(silhouette);
  const tags = tagBoxes(all);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const out: { c: Curb; score: number }[] = [];
  for (const c of CURBS) {
    if ((c.road === 1 ? c.x : c.y) !== nearLane(b, c.road)) continue;
    const [sx, sy] = project(c.x, c.y);
    const [x0, y0, x1, y1] = [sx + ENGINE_BOX.l, sy + ENGINE_BOX.t, sx + ENGINE_BOX.r, sy + ENGINE_BOX.b];
    if (hulls.some((h) => boxHitsHull(x0, y0, x1, y1, h))) continue;
    // share of the engine under a name tag
    const tagged = tags.reduce((sum, [a, p, q, r]) => sum + Math.max(0, Math.min(x1, q) - Math.max(x0, a)) * Math.max(0, Math.min(y1, r) - Math.max(y0, p)), 0) / ((x1 - x0) * (y1 - y0));
    const gap = Math.hypot(Math.max(b.x - c.x, 0, c.x - b.x - b.w), Math.max(b.y - c.y, 0, c.y - b.y - b.h));
    // close to the building, and to its middle, out from under the tags; a place that does not face the camera only
    // if nothing else does
    const score = gap + 0.3 * Math.hypot(c.x - cx, c.y - cy) + 80 * Math.min(1, tagged) + (facesCamera(b, c.x, c.y) ? 0 : 1000);
    out.push({ c, score });
  }
  return out.sort((p, q) => p.score - q.score);
}

let curbCache: { key: string; at: Map<number, Curb> } | null = null;

/**
 * One parking place per building, so two engines never stand on the same spot or overlap: buildings pick in turn,
 * and every place within ENGINE_GAP of a taken one is out for the rest. The building with the poorest best choice
 * picks first (so one with few options is not crowded out); each building is also tried first, and the round
 * with the best total wins. Depends on the view rotation (what faces the camera, what hides what), so it is cached
 * per rotation and town layout.
 */
function curbsFor(town: Building[]): Map<number, Curb> {
  // (rows arrive in any order: sort, so the same town always gets the same places)
  const all = [...town].sort((a, b) => a.id - b.id);
  const key = `${viewRotation()}|${all.map((b) => `${b.id}:${b.kind}:${b.x},${b.y},${b.w},${b.h}`).join(';')}`;
  if (curbCache?.key === key) return curbCache.at;
  const options = all.map((b) => ({ b, choices: curbChoices(b, all) }));
  const round = (first: number) => {
    const left = [...options];
    const taken: Curb[] = [];
    const free = (c: Curb) => taken.every((t) => Math.hypot(t.x - c.x, t.y - c.y) >= ENGINE_GAP);
    const at = new Map<number, Curb>();
    let total = 0;
    while (left.length) {
      let pick = first;
      if (left.length < options.length || first < 0) {
        let worst = -1;
        left.forEach((o, i) => {
          const best = o.choices.find((x) => free(x.c))?.score ?? Infinity;
          if (best > worst) { worst = best; pick = i; }
        });
      }
      const { b, choices } = left.splice(pick, 1)[0];
      const got = choices.find((x) => free(x.c)) ?? { c: choices[0]?.c ?? { x: b.x + b.w / 2, y: LANE.mainE, road: 0 as const, hidden: true }, score: 5000 };
      at.set(b.id, got.c);
      taken.push(got.c);
      total += got.score;
    }
    return { at, total };
  };
  let best = round(-1);
  for (let i = 0; i < options.length; i++) {
    const r = round(i);
    if (r.total < best.total - 0.01) best = r;
  }
  curbCache = { key, at: best.at };
  return best.at;
}

/** Where an engine sent to b parks (map space): its own place by the curb, in front of a face the camera sees. */
export function engineCurb(b: Building, all: Building[] = []): Curb {
  const town = all.some((o) => o.id === b.id) ? all : [...all, b];
  return curbsFor(town).get(b.id)!;
}

/**
 * Fire units leave the staging lot and drive the streets (never across lawns or through buildings): out onto the
 * main road eastbound, up or down the cross street, along the hillside street, then pull in to the curb.
 */
export function unitRoute(b: Building, all: Building[] = []): [number, number][] {
  const c = engineCurb(b, all);
  const out: [number, number][] = [STAGING, [STAGING[0], LANE.mainE]];
  const PULL = 26; // the last stretch: over into the curb lane
  if (c.road === 0) {
    if (c.y !== LANE.mainE) out.push([c.x - PULL, LANE.mainE]);
  } else if (c.road === 1) {
    const north = c.y < 448;
    const lane = north ? LANE.crossN : LANE.crossS; // turn left (north) or right (south) off the main road
    out.push([lane, LANE.mainE]);
    if (c.x !== lane) out.push([lane, c.y + (north ? PULL : -PULL)]);
  } else {
    out.push([LANE.crossN, LANE.mainE], [LANE.crossN, LANE.hillE]);
    if (c.y !== LANE.hillE) out.push([c.x - PULL, LANE.hillE]);
  }
  out.push([c.x, c.y]);
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
