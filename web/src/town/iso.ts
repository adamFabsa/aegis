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

/** Map (x, y, height z) -> screen point. */
export function project(x: number, y: number, z = 0): [number, number] {
  return [OX + C * (x - y), OY + 0.5 * (x + y) - z];
}

/** Transform that lays any map-space SVG content flat on the iso ground. */
export const GROUND_MATRIX = `matrix(${C} 0.5 ${-C} 0.5 ${OX} ${OY})`;

/** Map-space direction the wind blows toward, as a unit vector. */
export function windVector(dirDeg: number): [number, number] {
  const r = (dirDeg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/** Map-space vector -> screen-space vector. */
export function projectVec(dx: number, dy: number): [number, number] {
  return [C * (dx - dy), 0.5 * (dx + dy)];
}

export function pointsAttr(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}
