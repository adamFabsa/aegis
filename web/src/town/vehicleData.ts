// Vehicle sprite metadata and street-life helpers (see vehicles.tsx).
import type { CSSProperties } from 'react';
import { projectRaw, rot } from './iso';
import type { Building, Pack } from './types';
import { unitRoute } from './scene';

export const VEH_BOX = { w: 80, h: 60, ax: 40, ay: 36 }; // must match VW/VH/AX/AY in blender/build_vehicles.py
export type VehModel = 'sedanW' | 'sedanK' | 'sedanR' | 'suvS' | 'suvB' | 'pickup' | 'van' | 'engine';
export type Heading = 'e' | 'w' | 's' | 'n';
export const TRAFFIC: VehModel[] = ['sedanW', 'suvS', 'sedanK', 'pickup', 'sedanR', 'suvB'];

export const vehLook = (pack: Pack) => (pack === 'night' ? 'night' : 'dusk');
export function vehUrl(model: VehModel, hd: Heading, look: string): string {
  return `${import.meta.env.BASE_URL}sprites/veh_${model}_${hd}_${look}.webp`;
}

/** On-screen heading of travel from a to b (map points), in the current view rotation. */
export function headingOf(a: [number, number], b: [number, number]): Heading {
  const [ax, ay] = rot(a[0], a[1]);
  const [bx, by] = rot(b[0], b[1]);
  const dx = bx - ax;
  const dy = by - ay;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : (dy >= 0 ? 's' : 'n');
}

const unit = (hd: Heading): [number, number] => (hd === 'e' ? [1, 0] : hd === 'w' ? [-1, 0] : hd === 's' ? [0, 1] : [0, -1]);

/** Screen offset of a point on the vehicle: `along` map units ahead of its centre, `up` units above the road. */
export function vehOffset(hd: Heading, along: number, up: number): [number, number] {
  const [ux, uy] = unit(hd);
  const [ox, oy] = projectRaw(0, 0, 0);
  const [px, py] = projectRaw(ux * along, uy * along, up);
  return [px - ox, py - oy];
}


const SKINS = ['#F1CBA8', '#E2AD84', '#C68B5E', '#9A6440', '#6B4429', '#4A2F1F'];
const HAIR = ['#1A1716', '#3A281C', '#6A4A2C', '#B98C4E', '#8C8C8C', '#2B2B2B', '#5A2E1A'];
const SHIRTS = ['#E9E4DA', '#4F7FD9', '#C9473F', '#E8B04A', '#6FAF73', '#8D6BC4', '#35A2B6', '#D97B45', '#2D2F36', '#F2F2F0'];
const PANTS = ['#2A3954', '#1E1F24', '#5B4F3C', '#3B4A3A', '#6B6F78', '#C8C0AC', '#24324A', '#4A3A2E'];

/** Clothes, skin and hair for resident `i` (stable, varied). */
export function personStyle(i: number, shirt?: string): CSSProperties {
  return {
    color: shirt ?? SHIRTS[(i * 7 + 3) % SHIRTS.length],
    '--skin': SKINS[(i * 5 + 1) % SKINS.length],
    '--hair': HAIR[(i * 3 + 2) % HAIR.length],
    '--pants': PANTS[(i * 11 + 4) % PANTS.length],
  } as CSSProperties;
}


/** Where an engine on scene stands: the end of its route, facing the way it drove in. */
export function enginePark(b: Building, all: Building[]): { x: number; y: number; hd: Heading } {
  const route = unitRoute(b, all);
  const [x, y] = route[route.length - 1];
  return { x, y, hd: headingOf(route[Math.max(0, route.length - 2)], route[route.length - 1]) };
}

