// Isometric projection shared by the ground plane, billboards and the Blender sprites.
// Map space is the spec's 1000 x 620 grid (x east, y south). One map unit = one screen unit
// along each iso axis; the Blender camera uses the same true-isometric angle (1 m = 4 units).

export const VIEW_W = 1440;
export const VIEW_H = 980;
export const OX = 555;
export const OY = 120;
export const C = 0.8660254;

export const MAP_W = 1000;
export const MAP_H = 620;
export const CELL = 20;
export const COLS = 50;
export const ROWS = 31;

// ---------------------------------------------------------------- view rotation
// The camera can turn the town in 90 degree steps. Everything goes through rot(): map space is turned
// about the board centre (the same turn blender/build_*.py applies with --rots), then projected.
const RC_X = MAP_W / 2;
const RC_Y = MAP_H / 2;
let VIEW_ROT = 0;
export function setViewRotation(r: number) { VIEW_ROT = ((r % 4) + 4) % 4; }
export function viewRotation(): number { return VIEW_ROT; }

/** Map point -> turned ("view") map point. */
export function rot(x: number, y: number): [number, number] {
  const dx = x - RC_X;
  const dy = y - RC_Y;
  switch (VIEW_ROT) {
    case 1: return [RC_X + dy, RC_Y - dx];
    case 2: return [RC_X - dx, RC_Y - dy];
    case 3: return [RC_X - dy, RC_Y + dx];
    default: return [x, y];
  }
}

/** Map vector -> turned vector. */
export function rotVec(dx: number, dy: number): [number, number] {
  switch (VIEW_ROT) {
    case 1: return [dy, -dx];
    case 2: return [-dx, -dy];
    case 3: return [-dy, dx];
    default: return [dx, dy];
  }
}

/** Back-to-front sort key for anything standing at map point (x, y). */
export function depthOf(x: number, y: number): number {
  const [a, b] = rot(x, y);
  return a + b;
}

/** A map rectangle as it lies in the turned view (still axis aligned: turns are 90 degrees). */
export function rotRect(r: { x: number; y: number; w: number; h: number }) {
  const [ax, ay] = rot(r.x, r.y);
  const [bx, by] = rot(r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** View-space map point (already turned) -> screen point. */
export function projectRaw(x: number, y: number, z = 0): [number, number] {
  return [OX + C * (x - y), OY + 0.5 * (x + y) - z];
}

/** Map (x, y, height z) -> screen point. */
export function project(x: number, y: number, z = 0): [number, number] {
  const [a, b] = rot(x, y);
  return projectRaw(a, b, z);
}

/** Transform that lays any map-space SVG content flat on the iso ground (turn first, then project). */
export function groundMatrix(): string {
  const iso = `matrix(${C} 0.5 ${-C} 0.5 ${OX} ${OY})`;
  switch (VIEW_ROT) {
    case 1: return `${iso} matrix(0 -1 1 0 ${RC_X - RC_Y} ${RC_X + RC_Y})`;
    case 2: return `${iso} matrix(-1 0 0 -1 ${2 * RC_X} ${2 * RC_Y})`;
    case 3: return `${iso} matrix(0 1 -1 0 ${RC_X + RC_Y} ${RC_Y - RC_X})`;
    default: return iso;
  }
}

/** Map-space direction the wind blows toward, as a unit vector. */
export function windVector(dirDeg: number): [number, number] {
  const r = (dirDeg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/** Map-space vector -> screen-space vector. */
export function projectVec(dx: number, dy: number): [number, number] {
  const [a, b] = rotVec(dx, dy);
  return [C * (a - b), 0.5 * (a + b)];
}

export function pointsAttr(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/** Screen point -> map point (on the ground) for view rotation r. */
export function unproject(sx: number, sy: number, r: number): [number, number] {
  const d = (sx - OX) / C;
  const t = 2 * (sy - OY);
  const vx = (t + d) / 2;
  const vy = (t - d) / 2;
  const dx = vx - RC_X;
  const dy = vy - RC_Y;
  switch (((r % 4) + 4) % 4) {
    case 1: return [RC_X - dy, RC_Y + dx];
    case 2: return [RC_X - dx, RC_Y - dy];
    case 3: return [RC_X + dy, RC_Y - dx];
    default: return [vx, vy];
  }
}
